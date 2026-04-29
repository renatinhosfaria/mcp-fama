import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerAutomacaoTools(server: McpServer) {
  // 1. lead_automation_config - Lead automation/rotation config
  server.registerTool(
    'lead_automation_config',
    {
      title: 'Lead Automation Config',
      description:
        'Get current lead automation configurations (sistema_config_automacao_leads). ' +
        'For each config returns: rotation users, SLA cascata settings, and current rotation pointer ' +
        '(last user assigned and sequence position).',
      inputSchema: {
        active_only: z.boolean().optional().default(true).describe('Show only active configs (default true)'),
      },
    },
    async ({ active_only }) => {
      try {
        const where = active_only ? 'WHERE c.active = true' : '';
        const sql = `
          SELECT
            c.id, c.name, c.active,
            c.rotation_users,
            c.sla_cascata_enabled, c.sla_cascata_prazo_horas,
            c.created_at, c.updated_at,
            r.sequencia_atual,
            r.ultimo_usuario_id,
            u.full_name AS last_user_name,
            r.updated_at AS rotation_updated_at
          FROM sistema_config_automacao_leads c
          LEFT JOIN sistema_rotacao_leads r ON r.config_id = c.id
          LEFT JOIN sistema_users u ON r.ultimo_usuario_id = u.id
          ${where}
          ORDER BY c.id
        `;

        const result = await query(sql);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rowCount, configs: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching automation config: ${msg}` }], isError: true };
      }
    }
  );

  // 2. lead_rotation_history - Recent rotation events
  server.registerTool(
    'lead_rotation_history',
    {
      title: 'Lead Rotation History',
      description:
        'Show users that entered or left a rotation pool (sistema_config_automacao_leads_rotation_history). ' +
        'Useful to audit changes in lead distribution. Filters: config, user, currently_active, date range.',
      inputSchema: {
        config_id: z.number().optional().describe('Filter by automation config'),
        user_id: z.number().optional().describe('Filter by user'),
        currently_active: z.boolean().optional().describe('Only entries still active in rotation (left_at IS NULL)'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
      },
    },
    async ({ config_id, user_id, currently_active, limit }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (config_id !== undefined) {
          conditions.push(`h.config_id = $${idx}`);
          params.push(config_id);
          idx++;
        }
        if (user_id !== undefined) {
          conditions.push(`h.user_id = $${idx}`);
          params.push(user_id);
          idx++;
        }
        if (currently_active === true) {
          conditions.push(`h.left_at IS NULL`);
        } else if (currently_active === false) {
          conditions.push(`h.left_at IS NOT NULL`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx;

        const sql = `
          SELECT
            h.id, h.config_id, c.name AS config_name,
            h.user_id, u.full_name AS user_name,
            h.entered_at, h.left_at,
            CASE WHEN h.left_at IS NULL THEN 'active' ELSE 'left' END AS rotation_state,
            EXTRACT(EPOCH FROM (COALESCE(h.left_at, NOW()) - h.entered_at)) / 86400 AS days_in_rotation
          FROM sistema_config_automacao_leads_rotation_history h
          LEFT JOIN sistema_config_automacao_leads c ON h.config_id = c.id
          LEFT JOIN sistema_users u ON h.user_id = u.id
          ${where}
          ORDER BY h.entered_at DESC
          LIMIT $${limitIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rowCount, history: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching rotation history: ${msg}` }], isError: true };
      }
    }
  );
}
