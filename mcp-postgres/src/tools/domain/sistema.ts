import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerSistemaTools(server: McpServer) {
  // 1. list_users - All users with filters, excluding password_hash
  server.registerTool(
    'list_users',
    {
      title: 'List Users',
      description:
        'List all system users. Supports filters by role, department, and active status. ' +
        'Excludes password_hash from results.',
      inputSchema: {
        role: z.string().optional().describe('Filter by role'),
        department: z.string().optional().describe('Filter by department'),
        is_active: z.boolean().optional().describe('Filter by active status'),
      },
    },
    async ({ role, department, is_active }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (role) {
          conditions.push(`role = $${idx}`);
          params.push(role);
          idx++;
        }

        if (department) {
          conditions.push(`department = $${idx}`);
          params.push(department);
          idx++;
        }

        if (is_active !== undefined) {
          conditions.push(`is_active = $${idx}`);
          params.push(is_active);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT
            id, username, full_name, email, phone, role, department,
            is_active, whatsapp_instance, whatsapp_connected,
            last_login_at, created_at
          FROM sistema_users
          ${where}
          ORDER BY full_name ASC
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rows.length, users: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing users: ${msg}` }], isError: true };
      }
    }
  );

  // 2. broker_performance - Performance metrics for brokers
  server.registerTool(
    'broker_performance',
    {
      title: 'Broker Performance',
      description:
        'Get broker performance metrics: total clients, leads, sales, total sale value, ' +
        'conversion rate, and appointments count. Optional filter by broker and time period.',
      inputSchema: {
        broker_id: z.number().optional().describe('Filter by specific broker (user) ID'),
        period: z
          .enum(['30d', '90d', '1y'])
          .optional()
          .default('30d')
          .describe('Time period for metrics (default: 30d)'),
      },
    },
    async ({ broker_id, period }) => {
      try {
        const intervalMap: Record<string, string> = {
          '30d': '30 days',
          '90d': '90 days',
          '1y': '1 year',
        };
        const interval = intervalMap[period ?? '30d'] ?? '30 days';

        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (broker_id !== undefined) {
          conditions.push(`u.id = $${idx}`);
          params.push(broker_id);
          idx++;
        }

        const brokerWhere = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT
            u.id AS broker_id,
            u.full_name AS broker_name,
            COALESCE(clients.total, 0) AS total_clients,
            COALESCE(leads.total, 0) AS total_leads,
            COALESCE(sales.total, 0) AS total_sales,
            COALESCE(sales.total_value, 0) AS total_sale_value,
            CASE
              WHEN COALESCE(leads.total, 0) > 0
              THEN ROUND(COALESCE(sales.total, 0)::numeric / leads.total * 100, 2)
              ELSE 0
            END AS conversion_rate,
            COALESCE(appointments.total, 0) AS appointments_count
          FROM sistema_users u
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total
            FROM clientes c
            WHERE c.broker_id = u.id
              AND c.created_at >= NOW() - INTERVAL '${interval}'
          ) clients ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total
            FROM sistema_leads l
            WHERE l.broker_id = u.id
              AND l.created_at >= NOW() - INTERVAL '${interval}'
          ) leads ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total, COALESCE(SUM(v.value), 0) AS total_value
            FROM clientes_vendas v
            WHERE v.broker_id = u.id
              AND v.created_at >= NOW() - INTERVAL '${interval}'
          ) sales ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total
            FROM clientes_agendamentos ag
            WHERE ag.broker_id = u.id
              AND ag.created_at >= NOW() - INTERVAL '${interval}'
          ) appointments ON true
          WHERE u.is_active = true ${brokerWhere}
          ORDER BY total_sale_value DESC
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ period, brokers: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching broker performance: ${msg}` }], isError: true };
      }
    }
  );

  // 3. user_schedule - Work schedule for a user
  server.registerTool(
    'user_schedule',
    {
      title: 'User Schedule',
      description:
        'Get the work schedule (horarios) for a specific user. Returns day of week, ' +
        'start time, end time, and whether it is a full day.',
      inputSchema: {
        user_id: z.number().describe('User ID to get schedule for'),
      },
    },
    async ({ user_id }) => {
      try {
        const result = await query(
          `SELECT
             h.id,
             h.dia_semana AS day,
             h.horario_inicio AS start_time,
             h.horario_fim AS end_time,
             h.dia_todo AS full_day,
             u.full_name AS user_name
           FROM sistema_users_horarios h
           JOIN sistema_users u ON h.user_id = u.id
           WHERE h.user_id = $1
           ORDER BY
             CASE h.dia_semana
               WHEN 'segunda' THEN 1
               WHEN 'terca' THEN 2
               WHEN 'quarta' THEN 3
               WHEN 'quinta' THEN 4
               WHEN 'sexta' THEN 5
               WHEN 'sabado' THEN 6
               WHEN 'domingo' THEN 7
               ELSE 8
             END`,
          [user_id]
        );

        if (result.rows.length === 0) {
          return {
            content: [{ type: 'text', text: `No schedule found for user ${user_id}.` }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              user_id,
              user_name: result.rows[0].user_name,
              schedule: result.rows,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching schedule: ${msg}` }], isError: true };
      }
    }
  );

  // 4. daily_report - Daily summary of activity
  server.registerTool(
    'daily_report',
    {
      title: 'Daily Report',
      description:
        'Get a daily summary report: new leads, new clients, total sales value, ' +
        'appointments count, and SLA expirations. Optional date and broker filter.',
      inputSchema: {
        date: z.string().optional().describe('Date for the report (YYYY-MM-DD, defaults to today)'),
        broker_id: z.number().optional().describe('Filter by specific broker (user) ID'),
      },
    },
    async ({ date, broker_id }) => {
      try {
        const reportDate = date || new Date().toISOString().split('T')[0];
        const params: unknown[] = [reportDate];
        let idx = 2;

        let brokerFilter = '';
        if (broker_id !== undefined) {
          brokerFilter = `AND broker_id = $${idx}`;
          params.push(broker_id);
          idx++;
        }

        const [leadsRes, clientsRes, salesRes, appointmentsRes] = await Promise.all([
          query(
            `SELECT COUNT(*) AS new_leads
             FROM sistema_leads
             WHERE created_at::date = $1::date ${brokerFilter}`,
            params
          ),
          query(
            `SELECT COUNT(*) AS new_clients
             FROM clientes
             WHERE created_at::date = $1::date ${brokerFilter}`,
            params
          ),
          query(
            `SELECT
               COUNT(*) AS total_sales,
               COALESCE(SUM(value), 0) AS total_sales_value
             FROM clientes_vendas
             WHERE created_at::date = $1::date ${brokerFilter}`,
            params
          ),
          query(
            `SELECT COUNT(*) AS appointments_count
             FROM clientes_agendamentos
             WHERE scheduled_at::date = $1::date ${brokerFilter}`,
            params
          ),
        ]);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              date: reportDate,
              broker_id: broker_id || 'all',
              new_leads: parseInt(leadsRes.rows[0].new_leads, 10),
              new_clients: parseInt(clientsRes.rows[0].new_clients, 10),
              total_sales: parseInt(salesRes.rows[0].total_sales, 10),
              total_sales_value: parseFloat(salesRes.rows[0].total_sales_value),
              appointments_count: parseInt(appointmentsRes.rows[0].appointments_count, 10),
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error generating daily report: ${msg}` }], isError: true };
      }
    }
  );

  // 5. notifications - User notifications
  server.registerTool(
    'notifications',
    {
      title: 'Notifications',
      description:
        'Get notifications for a specific user. Supports filtering by unread-only and limit.',
      inputSchema: {
        user_id: z.number().describe('User ID to get notifications for'),
        unread_only: z.boolean().optional().default(false).describe('Only return unread notifications (default false)'),
        limit: z.number().optional().default(20).describe('Max results (default 20)'),
      },
    },
    async ({ user_id, unread_only, limit }) => {
      try {
        const conditions: string[] = [`n.user_id = $1`];
        const params: unknown[] = [user_id];
        let idx = 2;

        if (unread_only) {
          conditions.push(`n.is_read = false`);
        }

        params.push(limit);
        const limitIdx = idx;

        const sql = `
          SELECT
            n.id,
            n.type,
            n.priority,
            n.title,
            n.message,
            n.event_type,
            n.entity_type,
            n.entity_id,
            n.metadata,
            n.is_read,
            n.read_at,
            n.created_at
          FROM sistema_notificacoes n
          WHERE ${conditions.join(' AND ')}
          ORDER BY n.created_at DESC
          LIMIT $${limitIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rows.length, notifications: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching notifications: ${msg}` }], isError: true };
      }
    }
  );

  // 6. whatsapp_status - WhatsApp instances with user info
  server.registerTool(
    'whatsapp_status',
    {
      title: 'WhatsApp Status',
      description:
        'Get all WhatsApp instances with their status and associated user information. ' +
        'Returns instance name, status, user full name, and last connection time.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await query(
          `SELECT
             w.instancia_id,
             w.instance_name,
             w.instance_status AS status,
             w.last_connection,
             w.webhook,
             w.created_at,
             w.updated_at,
             u.id AS user_id,
             u.full_name AS user_name,
             u.email AS user_email
           FROM sistema_whatsapp_instances w
           LEFT JOIN sistema_users u ON w.user_id = u.id
           ORDER BY w.instance_name ASC`
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rows.length, instances: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching WhatsApp status: ${msg}` }], isError: true };
      }
    }
  );
}
