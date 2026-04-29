import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerAuthTools(server: McpServer) {
  // 1. auth_audit_log - Authentication audit events
  server.registerTool(
    'auth_audit_log',
    {
      title: 'Auth Audit Log',
      description:
        'Search authentication audit events (sistema_auth_audit_log). Filters by user, ' +
        'event_type (login_success, login_failed, logout, password_change, etc.), and date range. ' +
        'Returns user info, IP, user agent, metadata.',
      inputSchema: {
        user_id: z.number().optional().describe('Filter by user ID'),
        event_type: z.string().optional().describe('Filter by event_type'),
        ip_address: z.string().optional().describe('Filter by IP address (exact match)'),
        date_from: z.string().optional().describe('Filter from created_at (ISO string)'),
        date_to: z.string().optional().describe('Filter to created_at (ISO string)'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ user_id, event_type, ip_address, date_from, date_to, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (user_id !== undefined) {
          conditions.push(`a.user_id = $${idx}`);
          params.push(user_id);
          idx++;
        }
        if (event_type) {
          conditions.push(`a.event_type = $${idx}`);
          params.push(event_type);
          idx++;
        }
        if (ip_address) {
          conditions.push(`a.ip_address = $${idx}`);
          params.push(ip_address);
          idx++;
        }
        if (date_from) {
          conditions.push(`a.created_at >= $${idx}`);
          params.push(date_from);
          idx++;
        }
        if (date_to) {
          conditions.push(`a.created_at <= $${idx}`);
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
            a.id, a.user_id, u.full_name AS user_name, u.username,
            a.event_type, a.ip_address, a.user_agent,
            a.metadata, a.created_at
          FROM sistema_auth_audit_log a
          LEFT JOIN sistema_users u ON a.user_id = u.id
          ${where}
          ORDER BY a.created_at DESC
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
        return { content: [{ type: 'text', text: `Error fetching auth audit log: ${msg}` }], isError: true };
      }
    }
  );

  // 2. user_sessions - User session activity (online users)
  server.registerTool(
    'user_sessions',
    {
      title: 'User Sessions',
      description:
        'List user session records (sistema_user_sessions). By default returns currently-active sessions ' +
        '(ended_at IS NULL). Useful to see who is online. Filters by user, active_only, date range.',
      inputSchema: {
        user_id: z.number().optional().describe('Filter by user ID'),
        active_only: z.boolean().optional().default(true).describe('Show only active sessions (ended_at IS NULL). Default true.'),
        idle_within_minutes: z.number().optional().describe('Only sessions whose last_activity_at is within this many minutes (online presence).'),
        date_from: z.string().optional().describe('Filter from started_at (ISO string)'),
        date_to: z.string().optional().describe('Filter to started_at (ISO string)'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
      },
    },
    async ({ user_id, active_only, idle_within_minutes, date_from, date_to, limit }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (user_id !== undefined) {
          conditions.push(`s.user_id = $${idx}`);
          params.push(user_id);
          idx++;
        }
        if (active_only) {
          conditions.push(`s.ended_at IS NULL`);
        }
        if (idle_within_minutes !== undefined) {
          conditions.push(`s.last_activity_at >= NOW() - INTERVAL '1 minute' * $${idx}`);
          params.push(idle_within_minutes);
          idx++;
        }
        if (date_from) {
          conditions.push(`s.started_at >= $${idx}`);
          params.push(date_from);
          idx++;
        }
        if (date_to) {
          conditions.push(`s.started_at <= $${idx}`);
          params.push(date_to);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx;

        const sql = `
          SELECT
            s.id, s.user_id, u.full_name AS user_name, u.username, u.role,
            s.started_at, s.last_activity_at, s.ended_at,
            s.duration_minutes,
            s.ip_address, s.user_agent,
            CASE WHEN s.ended_at IS NULL THEN 'active' ELSE 'ended' END AS state,
            EXTRACT(EPOCH FROM (NOW() - s.last_activity_at)) / 60 AS minutes_since_activity
          FROM sistema_user_sessions s
          LEFT JOIN sistema_users u ON s.user_id = u.id
          ${where}
          ORDER BY s.last_activity_at DESC NULLS LAST
          LIMIT $${limitIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rowCount, sessions: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching user sessions: ${msg}` }], isError: true };
      }
    }
  );
}
