import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerLeadsTools(server: McpServer) {
  // 1. search_leads - Search leads with filters
  server.registerTool(
    'search_leads',
    {
      title: 'Search Leads',
      description:
        'Search leads by name, email, or phone (ILIKE). Supports filtering by status, source, broker, minimum score. Joins broker name.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Search term for full_name, email, or phone (ILIKE)'),
        status: z.string().optional().describe('Filter by lead status'),
        source: z.string().optional().describe('Filter by lead source'),
        broker_id: z.number().optional().describe('Filter by broker (sistema_users.id)'),
        min_score: z.number().optional().describe('Filter leads with score >= this value'),
        limit: z.number().optional().default(20).describe('Max results (default 20)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ search, status, source, broker_id, min_score, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (search) {
          conditions.push(
            `(l.full_name ILIKE $${idx} OR l.email ILIKE $${idx} OR l.phone ILIKE $${idx})`
          );
          params.push(`%${search}%`);
          idx++;
        }
        if (status) {
          conditions.push(`l.status = $${idx}`);
          params.push(status);
          idx++;
        }
        if (source) {
          conditions.push(`l.source = $${idx}`);
          params.push(source);
          idx++;
        }
        if (broker_id !== undefined) {
          conditions.push(`l.broker_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }
        if (min_score !== undefined) {
          conditions.push(`l.score >= $${idx}`);
          params.push(min_score);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx++;
        params.push(offset);
        const offsetIdx = idx++;

        const sql = `
          SELECT
            l.id, l.full_name, l.email, l.phone,
            l.source, l.status, l.score, l.interesse, l.budget,
            l.is_recurring, l.tags, l.last_activity_date,
            l.cliente_id, l.created_at, l.updated_at,
            u.full_name AS broker_name
          FROM sistema_leads l
          LEFT JOIN sistema_users u ON l.broker_id = u.id
          ${where}
          ORDER BY l.updated_at DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ count: result.rowCount, leads: result.rows }, null, 2) },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error searching leads: ${msg}` }], isError: true };
      }
    }
  );

  // 2. get_lead - Full lead details
  server.registerTool(
    'get_lead',
    {
      title: 'Get Lead',
      description:
        'Get full details for a lead by ID: profile, broker info, client association, active SLA cascata entries, and last 10 SLA logs.',
      inputSchema: {
        lead_id: z.number().describe('Lead ID'),
      },
    },
    async ({ lead_id }) => {
      try {
        const [leadRes, slaRes, slaLogsRes] = await Promise.all([
          query(
            `SELECT l.*,
                    u.full_name AS broker_name, u.username AS broker_username,
                    c.full_name AS client_name, c.email AS client_email, c.phone AS client_phone
             FROM sistema_leads l
             LEFT JOIN sistema_users u ON l.broker_id = u.id
             LEFT JOIN clientes c ON l.cliente_id = c.id
             WHERE l.id = $1`,
            [lead_id]
          ),
          query(
            `SELECT s.id, s.usuario_id, s.cliente_status, s.sla_cascata_status,
                    s.ativo, s.sequencia, s.data_inicio, s.data_limite,
                    s.full_name AS sla_entry_name,
                    u.full_name AS usuario_name,
                    s.cliente_id, s.cliente_original_id
             FROM sistema_leads_sla_cascata s
             LEFT JOIN sistema_users u ON s.usuario_id = u.id
             WHERE s.lead_id = $1 AND s.ativo = true
             ORDER BY s.sequencia ASC`,
            [lead_id]
          ),
          query(
            `SELECT sl.id, sl.event_type, sl.message, sl.details, sl.sequencia,
                    sl.created_at,
                    u.full_name AS usuario_name
             FROM sistema_leads_sla_cascata_logs sl
             LEFT JOIN sistema_users u ON sl.usuario_id = u.id
             WHERE sl.lead_id = $1
             ORDER BY sl.created_at DESC
             LIMIT 10`,
            [lead_id]
          ),
        ]);

        if (leadRes.rows.length === 0) {
          return { content: [{ type: 'text', text: `Lead with id ${lead_id} not found.` }], isError: true };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  lead: leadRes.rows[0],
                  active_sla_cascata: slaRes.rows,
                  recent_sla_logs: slaLogsRes.rows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching lead: ${msg}` }], isError: true };
      }
    }
  );

  // 3. lead_pipeline - Pipeline overview by status
  server.registerTool(
    'lead_pipeline',
    {
      title: 'Lead Pipeline',
      description:
        'Get lead pipeline overview: count of leads grouped by status. Optional broker and source filters.',
      inputSchema: {
        broker_id: z.number().optional().describe('Filter by broker ID'),
        source: z.string().optional().describe('Filter by lead source'),
      },
    },
    async ({ broker_id, source }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (broker_id !== undefined) {
          conditions.push(`l.broker_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }
        if (source) {
          conditions.push(`l.source = $${idx}`);
          params.push(source);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT l.status, COUNT(*)::int AS count
          FROM sistema_leads l
          ${where}
          GROUP BY l.status
          ORDER BY count DESC
        `;

        const result = await query(sql, params);

        const totalRes = await query(
          `SELECT COUNT(*)::int AS total FROM sistema_leads l ${where}`,
          params
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  total: totalRes.rows[0]?.total ?? 0,
                  pipeline: result.rows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching lead pipeline: ${msg}` }], isError: true };
      }
    }
  );

  // 4. sla_status - Active SLAs with time remaining
  server.registerTool(
    'sla_status',
    {
      title: 'SLA Status',
      description:
        'Show active SLA cascata entries (ativo=true) with time remaining until deadline. Optional broker filter and expiring_within_hours filter.',
      inputSchema: {
        broker_id: z.number().optional().describe('Filter by broker (usuario_id)'),
        expiring_within_hours: z
          .number()
          .optional()
          .describe('Only show SLAs expiring within this many hours'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
      },
    },
    async ({ broker_id, expiring_within_hours, limit }) => {
      try {
        const conditions: string[] = ['s.ativo = true'];
        const params: unknown[] = [];
        let idx = 1;

        if (broker_id !== undefined) {
          conditions.push(`s.usuario_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }
        if (expiring_within_hours !== undefined) {
          conditions.push(`s.data_limite <= NOW() + INTERVAL '1 hour' * $${idx}`);
          params.push(expiring_within_hours);
          idx++;
        }

        const where = `WHERE ${conditions.join(' AND ')}`;

        params.push(limit);
        const limitIdx = idx;

        const sql = `
          SELECT
            s.id, s.lead_id, s.cliente_id, s.usuario_id,
            s.sla_cascata_status, s.cliente_status,
            s.sequencia, s.data_inicio, s.data_limite,
            s.full_name AS sla_entry_name,
            u.full_name AS broker_name,
            l.full_name AS lead_name,
            c.full_name AS client_name,
            EXTRACT(EPOCH FROM (s.data_limite - NOW())) / 3600 AS hours_remaining,
            CASE
              WHEN s.data_limite < NOW() THEN 'EXPIRED'
              WHEN s.data_limite < NOW() + INTERVAL '4 hours' THEN 'CRITICAL'
              WHEN s.data_limite < NOW() + INTERVAL '12 hours' THEN 'WARNING'
              ELSE 'OK'
            END AS urgency
          FROM sistema_leads_sla_cascata s
          LEFT JOIN sistema_users u ON s.usuario_id = u.id
          LEFT JOIN sistema_leads l ON s.lead_id = l.id
          LEFT JOIN clientes c ON s.cliente_id = c.id
          ${where}
          ORDER BY s.data_limite ASC
          LIMIT $${limitIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ count: result.rowCount, sla_entries: result.rows }, null, 2) },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching SLA status: ${msg}` }], isError: true };
      }
    }
  );

  // 5. sla_expiring - SLAs expiring within X hours
  server.registerTool(
    'sla_expiring',
    {
      title: 'SLA Expiring Soon',
      description:
        'List SLAs expiring within a given number of hours (default 4). Joins user and client names for context.',
      inputSchema: {
        hours: z.number().optional().default(4).describe('Show SLAs expiring within this many hours (default 4)'),
        broker_id: z.number().optional().describe('Filter by broker (usuario_id)'),
      },
    },
    async ({ hours, broker_id }) => {
      try {
        const conditions: string[] = [
          's.ativo = true',
          `s.data_limite > NOW()`,
          `s.data_limite <= NOW() + INTERVAL '1 hour' * $1`,
        ];
        const params: unknown[] = [hours];
        let idx = 2;

        if (broker_id !== undefined) {
          conditions.push(`s.usuario_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }

        const where = `WHERE ${conditions.join(' AND ')}`;

        const sql = `
          SELECT
            s.id, s.lead_id, s.cliente_id, s.usuario_id,
            s.sla_cascata_status, s.cliente_status,
            s.sequencia, s.data_inicio, s.data_limite,
            s.full_name AS sla_entry_name,
            u.full_name AS broker_name,
            u.username AS broker_username,
            l.full_name AS lead_name, l.phone AS lead_phone,
            c.full_name AS client_name, c.phone AS client_phone,
            EXTRACT(EPOCH FROM (s.data_limite - NOW())) / 3600 AS hours_remaining
          FROM sistema_leads_sla_cascata s
          LEFT JOIN sistema_users u ON s.usuario_id = u.id
          LEFT JOIN sistema_leads l ON s.lead_id = l.id
          LEFT JOIN clientes c ON s.cliente_id = c.id
          ${where}
          ORDER BY s.data_limite ASC
        `;

        const result = await query(sql, params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { hours_threshold: hours, count: result.rowCount, expiring_slas: result.rows },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching expiring SLAs: ${msg}` }], isError: true };
      }
    }
  );

  // 6. create_lead - Insert a new lead
  server.registerTool(
    'create_lead',
    {
      title: 'Create Lead',
      description:
        'Create a new lead (sistema_leads). Required: full_name, phone, source. ' +
        'Optional: email, status, notes, broker_id, score, interesse, budget, tags (array), meta_data (object).',
      inputSchema: {
        full_name: z.string().describe('Lead full name (required)'),
        phone: z.string().describe('Lead phone (required)'),
        source: z.string().describe('Lead source (required, e.g. "Meta Ads", "WhatsApp", "Site")'),
        email: z.string().optional().describe('Lead email'),
        status: z.string().optional().describe('Initial status (defaults to "Sem Atendimento")'),
        notes: z.string().optional().describe('Free-text notes'),
        broker_id: z.number().optional().describe('Assigned broker (sistema_users.id)'),
        score: z.number().optional().describe('Initial lead score'),
        interesse: z.string().optional().describe('Lead interest (free text)'),
        budget: z.string().optional().describe('Budget (free text)'),
        tags: z.array(z.string()).optional().describe('Tags array'),
        source_details: z.record(z.unknown()).optional().describe('JSONB source_details (raw payload)'),
        meta_data: z.record(z.unknown()).optional().describe('JSONB meta_data'),
        cliente_id: z.number().optional().describe('Link to existing client'),
      },
    },
    async ({ full_name, phone, source, email, status, notes, broker_id, score, interesse, budget, tags, source_details, meta_data, cliente_id }) => {
      try {
        const sql = `
          INSERT INTO sistema_leads
            (full_name, phone, source, email, status, notes, broker_id, score, interesse, budget,
             tags, source_details, meta_data, cliente_id, created_at, updated_at, last_activity_date)
          VALUES ($1, $2, $3, $4, COALESCE($5, 'Sem Atendimento'), $6, $7, COALESCE($8, 0),
                  $9, $10, COALESCE($11, '[]'::jsonb), $12, COALESCE($13, '{}'::jsonb), $14, NOW(), NOW(), NOW())
          RETURNING *
        `;
        const params = [
          full_name, phone, source, email ?? null, status ?? null, notes ?? null,
          broker_id ?? null, score ?? null, interesse ?? null, budget ?? null,
          tags ? JSON.stringify(tags) : null,
          source_details ? JSON.stringify(source_details) : null,
          meta_data ? JSON.stringify(meta_data) : null,
          cliente_id ?? null,
        ];
        const result = await query(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify({ created: result.rows[0] }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error creating lead: ${msg}` }], isError: true };
      }
    }
  );

  // 7. update_lead - Dynamic update of a lead
  server.registerTool(
    'update_lead',
    {
      title: 'Update Lead',
      description:
        'Update a lead with a dynamic SET clause. Only provided fields are updated. ' +
        'Use assign_lead for broker reassignment if you want a quick shortcut.',
      inputSchema: {
        lead_id: z.number().describe('Lead ID to update (required)'),
        status: z.string().optional().describe('New status'),
        notes: z.string().optional().describe('Replace notes'),
        broker_id: z.number().optional().describe('Reassign broker'),
        score: z.number().optional().describe('Update score'),
        interesse: z.string().optional().describe('Update interesse'),
        budget: z.string().optional().describe('Update budget'),
        tags: z.array(z.string()).optional().describe('Replace tags array'),
        cliente_id: z.number().optional().describe('Link to client (or pass null/0 to unlink with caution)'),
        full_name: z.string().optional().describe('Update full name'),
        email: z.string().optional().describe('Update email'),
        phone: z.string().optional().describe('Update phone'),
        meta_data: z.record(z.unknown()).optional().describe('Replace meta_data JSONB'),
      },
    },
    async ({ lead_id, status, notes, broker_id, score, interesse, budget, tags, cliente_id, full_name, email, phone, meta_data }) => {
      try {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        const fields: Array<{ key: string; value: unknown; jsonb?: boolean }> = [
          { key: 'status', value: status },
          { key: 'notes', value: notes },
          { key: 'broker_id', value: broker_id },
          { key: 'score', value: score },
          { key: 'interesse', value: interesse },
          { key: 'budget', value: budget },
          { key: 'tags', value: tags ? JSON.stringify(tags) : undefined, jsonb: true },
          { key: 'cliente_id', value: cliente_id },
          { key: 'full_name', value: full_name },
          { key: 'email', value: email },
          { key: 'phone', value: phone },
          { key: 'meta_data', value: meta_data ? JSON.stringify(meta_data) : undefined, jsonb: true },
        ];

        for (const { key, value, jsonb } of fields) {
          if (value !== undefined) {
            setClauses.push(jsonb ? `${key} = $${idx}::jsonb` : `${key} = $${idx}`);
            params.push(value);
            idx++;
          }
        }

        if (setClauses.length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };
        }

        setClauses.push(`updated_at = NOW()`);
        setClauses.push(`last_activity_date = NOW()`);

        params.push(lead_id);
        const idIdx = idx;

        const sql = `UPDATE sistema_leads SET ${setClauses.join(', ')} WHERE id = $${idIdx} RETURNING *`;
        const result = await query(sql, params);

        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: `Lead with id ${lead_id} not found.` }], isError: true };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ updated: result.rows[0] }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error updating lead: ${msg}` }], isError: true };
      }
    }
  );

  // 8. assign_lead - Reassign lead to a broker (with audit log)
  server.registerTool(
    'assign_lead',
    {
      title: 'Assign Lead',
      description:
        'Reassign a lead to a different broker. Updates broker_id, last_activity_date, ' +
        'and bumps updated_at. Returns the updated lead with new broker info.',
      inputSchema: {
        lead_id: z.number().describe('Lead ID to reassign'),
        broker_id: z.number().describe('New broker (sistema_users.id)'),
      },
    },
    async ({ lead_id, broker_id }) => {
      try {
        const sql = `
          UPDATE sistema_leads
          SET broker_id = $1, updated_at = NOW(), last_activity_date = NOW()
          WHERE id = $2
          RETURNING id, full_name, broker_id, status, updated_at,
                    (SELECT full_name FROM sistema_users WHERE id = $1) AS broker_name
        `;
        const result = await query(sql, [broker_id, lead_id]);
        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: `Lead with id ${lead_id} not found.` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ assigned: result.rows[0] }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error assigning lead: ${msg}` }], isError: true };
      }
    }
  );

  // 9. lead_sources - Lead source analytics
  server.registerTool(
    'lead_sources',
    {
      title: 'Lead Sources',
      description:
        'Analyze lead sources: count and average score grouped by source. Optional date range filter.',
      inputSchema: {
        date_from: z.string().optional().describe('Filter from date (ISO string, based on created_at)'),
        date_to: z.string().optional().describe('Filter to date (ISO string, based on created_at)'),
      },
    },
    async ({ date_from, date_to }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (date_from) {
          conditions.push(`l.created_at >= $${idx}`);
          params.push(date_from);
          idx++;
        }
        if (date_to) {
          conditions.push(`l.created_at <= $${idx}`);
          params.push(date_to);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT
            l.source,
            COUNT(*)::int AS count,
            ROUND(AVG(l.score)::numeric, 2) AS avg_score,
            MIN(l.created_at) AS earliest,
            MAX(l.created_at) AS latest
          FROM sistema_leads l
          ${where}
          GROUP BY l.source
          ORDER BY count DESC
        `;

        const result = await query(sql, params);

        const totalRes = await query(
          `SELECT COUNT(*)::int AS total FROM sistema_leads l ${where}`,
          params
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  total_leads: totalRes.rows[0]?.total ?? 0,
                  sources: result.rows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching lead sources: ${msg}` }], isError: true };
      }
    }
  );
}
