import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerWebhooksTools(server: McpServer) {
  // 1. list_webhook_configs - List configured outbound webhooks
  server.registerTool(
    'list_webhook_configs',
    {
      title: 'List Webhook Configs',
      description:
        'List configured outbound webhooks (sistema_webhook_configs) with target URLs, ' +
        'subscribed events, retry policy and active status. Excludes the secret value.',
      inputSchema: {
        is_active: z.boolean().optional().describe('Filter by active status'),
      },
    },
    async ({ is_active }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (is_active !== undefined) {
          conditions.push(`w.is_active = $${idx}`);
          params.push(is_active);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT
            w.id, w.name, w.target_url, w.is_active,
            w.events, w.headers, w.retry_policy, w.selected_fields,
            w.created_by, u.full_name AS created_by_name,
            w.created_at, w.updated_at,
            (SELECT COUNT(*) FROM sistema_webhook_events e WHERE e.config_id = w.id) AS total_events,
            (SELECT COUNT(*) FROM sistema_webhook_events e WHERE e.config_id = w.id AND e.status = 'failed') AS failed_events
          FROM sistema_webhook_configs w
          LEFT JOIN sistema_users u ON w.created_by = u.id
          ${where}
          ORDER BY w.created_at DESC
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rowCount, configs: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing webhook configs: ${msg}` }], isError: true };
      }
    }
  );

  // 2. search_webhook_events - Outbound webhook delivery history
  server.registerTool(
    'search_webhook_events',
    {
      title: 'Search Webhook Events',
      description:
        'Search outbound webhook delivery history (sistema_webhook_events) with filters: ' +
        'config_id, event_type, status (pending/sent/failed), date range, only_failed. ' +
        'Useful for debugging integrations (Meta lead webhooks, n8n, etc.).',
      inputSchema: {
        config_id: z.number().optional().describe('Filter by webhook config ID'),
        event_type: z.string().optional().describe('Filter by event_type (e.g. "lead.created")'),
        status: z.string().optional().describe('Filter by delivery status (pending, sent, failed)'),
        only_failed: z.boolean().optional().default(false).describe('Shortcut for status = failed'),
        date_from: z.string().optional().describe('Filter from created_at (ISO string)'),
        date_to: z.string().optional().describe('Filter to created_at (ISO string)'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ config_id, event_type, status, only_failed, date_from, date_to, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (config_id !== undefined) {
          conditions.push(`e.config_id = $${idx}`);
          params.push(config_id);
          idx++;
        }
        if (event_type) {
          conditions.push(`e.event_type = $${idx}`);
          params.push(event_type);
          idx++;
        }
        if (only_failed) {
          conditions.push(`e.status = 'failed'`);
        } else if (status) {
          conditions.push(`e.status = $${idx}`);
          params.push(status);
          idx++;
        }
        if (date_from) {
          conditions.push(`e.created_at >= $${idx}`);
          params.push(date_from);
          idx++;
        }
        if (date_to) {
          conditions.push(`e.created_at <= $${idx}`);
          params.push(date_to);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx++;
        params.push(offset);
        const offsetIdx = idx++;

        const sql = `
          SELECT
            e.id, e.config_id, c.name AS config_name, c.target_url,
            e.event_type, e.status, e.http_status_code,
            e.attempt_count, e.next_retry_at, e.sent_at, e.completed_at,
            e.duration, e.error_message,
            LEFT(e.response_body, 500) AS response_body_snippet,
            e.payload,
            e.created_at
          FROM sistema_webhook_events e
          LEFT JOIN sistema_webhook_configs c ON e.config_id = c.id
          ${where}
          ORDER BY e.created_at DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rowCount, events: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error searching webhook events: ${msg}` }], isError: true };
      }
    }
  );

  // 3. webhook_event_stats - Aggregate stats per config
  server.registerTool(
    'webhook_event_stats',
    {
      title: 'Webhook Event Stats',
      description:
        'Aggregate webhook delivery statistics per config: counts by status, average duration, ' +
        'last failure timestamp. Optional period filter (e.g. "7d", "30d").',
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe('Time period filter (e.g. "24h", "7d", "30d"). Default: all-time.'),
      },
    },
    async ({ period }) => {
      try {
        let dateClause = '';
        if (period) {
          const match = period.match(/^(\d+)(h|d|m|y)$/i);
          if (match) {
            const value = parseInt(match[1], 10);
            const unitMap: Record<string, string> = { h: 'hours', d: 'days', m: 'months', y: 'years' };
            const unit = unitMap[match[2].toLowerCase()] || 'days';
            dateClause = ` AND e.created_at >= NOW() - INTERVAL '${value} ${unit}'`;
          }
        }

        const sql = `
          SELECT
            c.id AS config_id,
            c.name AS config_name,
            c.target_url,
            c.is_active,
            COUNT(e.id)::int AS total_events,
            COUNT(e.id) FILTER (WHERE e.status = 'sent')::int AS sent,
            COUNT(e.id) FILTER (WHERE e.status = 'pending')::int AS pending,
            COUNT(e.id) FILTER (WHERE e.status = 'failed')::int AS failed,
            ROUND(AVG(e.duration)::numeric, 2) AS avg_duration_ms,
            MAX(e.created_at) FILTER (WHERE e.status = 'failed') AS last_failure_at,
            MAX(e.created_at) FILTER (WHERE e.status = 'sent') AS last_success_at
          FROM sistema_webhook_configs c
          LEFT JOIN sistema_webhook_events e ON e.config_id = c.id${dateClause}
          GROUP BY c.id, c.name, c.target_url, c.is_active
          ORDER BY total_events DESC
        `;

        const result = await query(sql);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ period: period || 'all-time', stats: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching webhook stats: ${msg}` }], isError: true };
      }
    }
  );
}
