import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerClientesTools(server: McpServer) {
  // 1. search_clients - Search clients with filters
  server.registerTool(
    'search_clients',
    {
      title: 'Search Clients',
      description:
        'Search clients by name, email, phone, or CPF (ILIKE). Supports filtering by status, source, broker, WhatsApp availability. Returns broker name via join.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Search term for full_name, email, phone, or cpf (ILIKE)'),
        status: z.string().optional().describe('Filter by client status'),
        source: z.string().optional().describe('Filter by lead source'),
        broker_id: z.number().optional().describe('Filter by broker (sistema_users.id)'),
        has_whatsapp: z
          .boolean()
          .optional()
          .describe('Filter by WhatsApp availability (haswhatsapp)'),
        limit: z.number().optional().default(20).describe('Max results (default 20)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ search, status, source, broker_id, has_whatsapp, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (search) {
          conditions.push(
            `(c.full_name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx} OR c.cpf ILIKE $${idx})`
          );
          params.push(`%${search}%`);
          idx++;
        }
        if (status) {
          conditions.push(`c.status = $${idx}`);
          params.push(status);
          idx++;
        }
        if (source) {
          conditions.push(`c.source = $${idx}`);
          params.push(source);
          idx++;
        }
        if (broker_id !== undefined) {
          conditions.push(`c.broker_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }
        if (has_whatsapp !== undefined) {
          conditions.push(`c.haswhatsapp = $${idx}`);
          params.push(has_whatsapp);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx++;
        params.push(offset);
        const offsetIdx = idx++;

        const sql = `
          SELECT
            c.id, c.full_name, c.email, c.phone, c.cpf,
            c.source, c.status, c.haswhatsapp, c.preferred_contact,
            c.created_at, c.updated_at,
            u.full_name AS broker_name
          FROM clientes c
          LEFT JOIN sistema_users u ON c.broker_id = u.id
          ${where}
          ORDER BY c.updated_at DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ count: result.rowCount, clients: result.rows }, null, 2) },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error searching clients: ${msg}` }], isError: true };
      }
    }
  );

  // 2. get_client - Full client details
  server.registerTool(
    'get_client',
    {
      title: 'Get Client',
      description:
        'Get full details for a client by ID: profile, broker info, last 10 notes, appointments, sales, visits, and associated leads count.',
      inputSchema: {
        client_id: z.number().describe('Client ID'),
      },
    },
    async ({ client_id }) => {
      try {
        const [clientRes, notesRes, appointmentsRes, salesRes, visitsRes, leadsCountRes] =
          await Promise.all([
            query(
              `SELECT c.*, u.full_name AS broker_name, u.username AS broker_username
               FROM clientes c
               LEFT JOIN sistema_users u ON c.broker_id = u.id
               WHERE c.id = $1`,
              [client_id]
            ),
            query(
              `SELECT a.id, a.text, a.created_at, a.updated_at, u.full_name AS author_name
               FROM clientes_id_anotacoes a
               LEFT JOIN sistema_users u ON a.user_id = u.id
               WHERE a.cliente_id = $1
               ORDER BY a.created_at DESC
               LIMIT 10`,
              [client_id]
            ),
            query(
              `SELECT ag.id, ag.title, ag.type, ag.status, ag.scheduled_at, ag.end_at,
                      ag.location, ag.address, ag.notes,
                      u.full_name AS created_by, b.full_name AS broker_name
               FROM clientes_agendamentos ag
               LEFT JOIN sistema_users u ON ag.user_id = u.id
               LEFT JOIN sistema_users b ON ag.broker_id = b.id
               WHERE ag.cliente_id = $1
               ORDER BY ag.scheduled_at DESC`,
              [client_id]
            ),
            query(
              `SELECT v.id, v.value, v.notes, v.sold_at, v.property_type, v.builder_name,
                      v.block, v.unit, v.payment_method, v.commission, v.bonus,
                      v.total_commission, v.development_name, v.cpf,
                      u.full_name AS created_by, b.full_name AS broker_name
               FROM clientes_vendas v
               LEFT JOIN sistema_users u ON v.user_id = u.id
               LEFT JOIN sistema_users b ON v.broker_id = b.id
               WHERE v.cliente_id = $1
               ORDER BY v.sold_at DESC`,
              [client_id]
            ),
            query(
              `SELECT vi.id, vi.property_id, vi.notes, vi.visited_at, vi.temperature,
                      vi.visit_description, vi.next_steps,
                      u.full_name AS created_by, b.full_name AS broker_name
               FROM clientes_visitas vi
               LEFT JOIN sistema_users u ON vi.user_id = u.id
               LEFT JOIN sistema_users b ON vi.broker_id = b.id
               WHERE vi.cliente_id = $1
               ORDER BY vi.visited_at DESC`,
              [client_id]
            ),
            query(
              `SELECT COUNT(*)::int AS leads_count FROM sistema_leads WHERE cliente_id = $1`,
              [client_id]
            ),
          ]);

        if (clientRes.rows.length === 0) {
          return { content: [{ type: 'text', text: `Client with id ${client_id} not found.` }], isError: true };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  client: clientRes.rows[0],
                  notes: notesRes.rows,
                  appointments: appointmentsRes.rows,
                  sales: salesRes.rows,
                  visits: visitsRes.rows,
                  leads_count: leadsCountRes.rows[0]?.leads_count ?? 0,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching client: ${msg}` }], isError: true };
      }
    }
  );

  // 3. client_timeline - Unified timeline of all client events
  server.registerTool(
    'client_timeline',
    {
      title: 'Client Timeline',
      description:
        'Get a unified timeline of all events (notes, appointments, visits, sales) for a client, ordered by date descending.',
      inputSchema: {
        client_id: z.number().describe('Client ID'),
        limit: z.number().optional().default(50).describe('Max events to return (default 50)'),
      },
    },
    async ({ client_id, limit }) => {
      try {
        const sql = `
          (
            SELECT
              'note' AS event_type,
              a.id AS event_id,
              a.text AS description,
              a.created_at AS event_date,
              u.full_name AS user_name
            FROM clientes_id_anotacoes a
            LEFT JOIN sistema_users u ON a.user_id = u.id
            WHERE a.cliente_id = $1
          )
          UNION ALL
          (
            SELECT
              'appointment' AS event_type,
              ag.id AS event_id,
              COALESCE(ag.title, '') || ' (' || COALESCE(ag.type, '') || ' - ' || COALESCE(ag.status, '') || ')' AS description,
              ag.scheduled_at AS event_date,
              u.full_name AS user_name
            FROM clientes_agendamentos ag
            LEFT JOIN sistema_users u ON ag.user_id = u.id
            WHERE ag.cliente_id = $1
          )
          UNION ALL
          (
            SELECT
              'visit' AS event_type,
              vi.id AS event_id,
              COALESCE(vi.visit_description, vi.notes, '') AS description,
              vi.visited_at AS event_date,
              u.full_name AS user_name
            FROM clientes_visitas vi
            LEFT JOIN sistema_users u ON vi.user_id = u.id
            WHERE vi.cliente_id = $1
          )
          UNION ALL
          (
            SELECT
              'sale' AS event_type,
              v.id AS event_id,
              COALESCE(v.development_name, '') || ' - R$ ' || COALESCE(v.value::text, '0') AS description,
              v.sold_at AS event_date,
              u.full_name AS user_name
            FROM clientes_vendas v
            LEFT JOIN sistema_users u ON v.user_id = u.id
            WHERE v.cliente_id = $1
          )
          ORDER BY event_date DESC
          LIMIT $2
        `;

        const result = await query(sql, [client_id, limit]);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ client_id, events: result.rows }, null, 2) },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching timeline: ${msg}` }], isError: true };
      }
    }
  );

  // 4. add_client_note - Insert a new note for a client
  server.registerTool(
    'add_client_note',
    {
      title: 'Add Client Note',
      description: 'Add a new note/annotation to a client record.',
      inputSchema: {
        client_id: z.number().describe('Client ID'),
        user_id: z.number().describe('User ID of the note author (sistema_users.id)'),
        text: z.string().describe('Note content'),
      },
    },
    async ({ client_id, user_id, text }) => {
      try {
        const result = await query(
          `INSERT INTO clientes_id_anotacoes (cliente_id, user_id, text, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           RETURNING id, cliente_id, user_id, text, created_at`,
          [client_id, user_id, text]
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify({ success: true, note: result.rows[0] }, null, 2) },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error adding note: ${msg}` }], isError: true };
      }
    }
  );

  // 5. list_appointments - List appointments with filters
  server.registerTool(
    'list_appointments',
    {
      title: 'List Appointments',
      description:
        'List client appointments with flexible filters: client, broker, status, type, upcoming only, date range. Joins client and user names.',
      inputSchema: {
        client_id: z.number().optional().describe('Filter by client ID'),
        broker_id: z.number().optional().describe('Filter by broker ID'),
        status: z.string().optional().describe('Filter by appointment status'),
        type: z.string().optional().describe('Filter by appointment type'),
        upcoming_only: z
          .boolean()
          .optional()
          .default(false)
          .describe('Show only upcoming appointments (scheduled_at > now())'),
        date_from: z.string().optional().describe('Filter from date (ISO string)'),
        date_to: z.string().optional().describe('Filter to date (ISO string)'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
      },
    },
    async ({ client_id, broker_id, status, type, upcoming_only, date_from, date_to, limit }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (client_id !== undefined) {
          conditions.push(`ag.cliente_id = $${idx}`);
          params.push(client_id);
          idx++;
        }
        if (broker_id !== undefined) {
          conditions.push(`ag.broker_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }
        if (status) {
          conditions.push(`ag.status = $${idx}`);
          params.push(status);
          idx++;
        }
        if (type) {
          conditions.push(`ag.type = $${idx}`);
          params.push(type);
          idx++;
        }
        if (upcoming_only) {
          conditions.push(`ag.scheduled_at > NOW()`);
        }
        if (date_from) {
          conditions.push(`ag.scheduled_at >= $${idx}`);
          params.push(date_from);
          idx++;
        }
        if (date_to) {
          conditions.push(`ag.scheduled_at <= $${idx}`);
          params.push(date_to);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx;

        const sql = `
          SELECT
            ag.id, ag.title, ag.type, ag.status,
            ag.scheduled_at, ag.end_at,
            ag.location, ag.address, ag.notes,
            c.full_name AS client_name, c.phone AS client_phone,
            u.full_name AS created_by,
            b.full_name AS broker_name
          FROM clientes_agendamentos ag
          LEFT JOIN clientes c ON ag.cliente_id = c.id
          LEFT JOIN sistema_users u ON ag.user_id = u.id
          LEFT JOIN sistema_users b ON ag.broker_id = b.id
          ${where}
          ORDER BY ag.scheduled_at DESC
          LIMIT $${limitIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ count: result.rowCount, appointments: result.rows }, null, 2) },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing appointments: ${msg}` }], isError: true };
      }
    }
  );

  // 6. client_stats - Aggregate stats on clients
  server.registerTool(
    'client_stats',
    {
      title: 'Client Stats',
      description:
        'Get aggregate client statistics: count by status, by source, and by broker. Optional broker_id filter and time period (e.g. "30d", "90d", "1y").',
      inputSchema: {
        broker_id: z.number().optional().describe('Filter by broker ID'),
        period: z
          .string()
          .optional()
          .describe('Time period filter, e.g. "30d", "90d", "1y" (based on created_at)'),
      },
    },
    async ({ broker_id, period }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (broker_id !== undefined) {
          conditions.push(`c.broker_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }

        if (period) {
          const match = period.match(/^(\d+)(d|m|y)$/i);
          if (match) {
            const value = parseInt(match[1], 10);
            const unitMap: Record<string, string> = { d: 'days', m: 'months', y: 'years' };
            const unit = unitMap[match[2].toLowerCase()] || 'days';
            conditions.push(`c.created_at >= NOW() - INTERVAL '${value} ${unit}'`);
          }
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [byStatus, bySource, byBroker] = await Promise.all([
          query(
            `SELECT c.status, COUNT(*)::int AS count
             FROM clientes c ${where}
             GROUP BY c.status ORDER BY count DESC`,
            params
          ),
          query(
            `SELECT c.source, COUNT(*)::int AS count
             FROM clientes c ${where}
             GROUP BY c.source ORDER BY count DESC`,
            params
          ),
          query(
            `SELECT u.full_name AS broker_name, c.broker_id, COUNT(*)::int AS count
             FROM clientes c
             LEFT JOIN sistema_users u ON c.broker_id = u.id
             ${where}
             GROUP BY c.broker_id, u.full_name ORDER BY count DESC`,
            params
          ),
        ]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  by_status: byStatus.rows,
                  by_source: bySource.rows,
                  by_broker: byBroker.rows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching client stats: ${msg}` }], isError: true };
      }
    }
  );

  // 7. create_appointment - Insert a new appointment
  server.registerTool(
    'create_appointment',
    {
      title: 'Create Appointment',
      description:
        'Create a new appointment (clientes_agendamentos). Required: cliente_id, type, status, ' +
        'scheduled_at. Optional: title, end_at, broker_id, user_id (creator), location, address, notes.',
      inputSchema: {
        cliente_id: z.number().describe('Client ID'),
        type: z.string().describe('Appointment type (e.g. "Visita", "Reunião", "Ligação")'),
        status: z.string().describe('Initial status (e.g. "Agendado", "Confirmado")'),
        scheduled_at: z.string().describe('Scheduled timestamp (ISO 8601)'),
        title: z.string().optional().describe('Appointment title'),
        end_at: z.string().optional().describe('End timestamp (ISO 8601)'),
        broker_id: z.number().optional().describe('Assigned broker (sistema_users.id)'),
        user_id: z.number().optional().describe('Creator user ID'),
        location: z.string().optional().describe('Location label'),
        address: z.string().optional().describe('Address'),
        notes: z.string().optional().describe('Notes'),
      },
    },
    async ({ cliente_id, type, status, scheduled_at, title, end_at, broker_id, user_id, location, address, notes }) => {
      try {
        const sql = `
          INSERT INTO clientes_agendamentos
            (cliente_id, type, status, scheduled_at, title, end_at, broker_id, user_id, location, address, notes, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
          RETURNING *
        `;
        const params = [
          cliente_id, type, status, scheduled_at,
          title ?? null, end_at ?? null,
          broker_id ?? null, user_id ?? null,
          location ?? null, address ?? null, notes ?? null,
        ];
        const result = await query(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify({ created: result.rows[0] }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error creating appointment: ${msg}` }], isError: true };
      }
    }
  );

  // 8. update_appointment - Dynamic update
  server.registerTool(
    'update_appointment',
    {
      title: 'Update Appointment',
      description:
        'Update an appointment with a dynamic SET clause. Only provided fields are changed.',
      inputSchema: {
        appointment_id: z.number().describe('Appointment ID'),
        type: z.string().optional().describe('New type'),
        status: z.string().optional().describe('New status'),
        scheduled_at: z.string().optional().describe('New scheduled_at (ISO)'),
        end_at: z.string().optional().describe('New end_at (ISO)'),
        title: z.string().optional().describe('New title'),
        broker_id: z.number().optional().describe('Reassign broker'),
        location: z.string().optional().describe('New location'),
        address: z.string().optional().describe('New address'),
        notes: z.string().optional().describe('New notes'),
      },
    },
    async ({ appointment_id, type, status, scheduled_at, end_at, title, broker_id, location, address, notes }) => {
      try {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        const fields: Array<{ key: string; value: unknown }> = [
          { key: 'type', value: type },
          { key: 'status', value: status },
          { key: 'scheduled_at', value: scheduled_at },
          { key: 'end_at', value: end_at },
          { key: 'title', value: title },
          { key: 'broker_id', value: broker_id },
          { key: 'location', value: location },
          { key: 'address', value: address },
          { key: 'notes', value: notes },
        ];

        for (const { key, value } of fields) {
          if (value !== undefined) {
            setClauses.push(`${key} = $${idx}`);
            params.push(value);
            idx++;
          }
        }

        if (setClauses.length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(appointment_id);
        const idIdx = idx;

        const sql = `UPDATE clientes_agendamentos SET ${setClauses.join(', ')} WHERE id = $${idIdx} RETURNING *`;
        const result = await query(sql, params);

        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: `Appointment ${appointment_id} not found.` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ updated: result.rows[0] }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error updating appointment: ${msg}` }], isError: true };
      }
    }
  );

  // 9. create_visit - Insert visit record
  server.registerTool(
    'create_visit',
    {
      title: 'Create Visit',
      description:
        'Register a property visit for a client (clientes_visitas). Required: cliente_id, ' +
        'property_id (text reference), visited_at. Optional: temperature (1-5), notes, ' +
        'visit_description, next_steps, broker_id, user_id.',
      inputSchema: {
        cliente_id: z.number().describe('Client ID'),
        property_id: z.string().describe('Property reference (free-form text)'),
        visited_at: z.string().describe('Visit timestamp (ISO 8601)'),
        temperature: z.number().int().min(1).max(5).optional().describe('Lead temperature 1-5 after visit'),
        notes: z.string().optional().describe('Notes'),
        visit_description: z.string().optional().describe('Visit description'),
        next_steps: z.string().optional().describe('Next steps free text'),
        broker_id: z.number().optional().describe('Broker who conducted the visit'),
        user_id: z.number().optional().describe('Creator user ID'),
      },
    },
    async ({ cliente_id, property_id, visited_at, temperature, notes, visit_description, next_steps, broker_id, user_id }) => {
      try {
        const sql = `
          INSERT INTO clientes_visitas
            (cliente_id, property_id, visited_at, temperature, notes, visit_description, next_steps, broker_id, user_id, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          RETURNING *
        `;
        const params = [
          cliente_id, property_id, visited_at,
          temperature ?? null, notes ?? null, visit_description ?? null, next_steps ?? null,
          broker_id ?? null, user_id ?? null,
        ];
        const result = await query(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify({ created: result.rows[0] }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error creating visit: ${msg}` }], isError: true };
      }
    }
  );

  // 10. create_sale - Insert sale record
  server.registerTool(
    'create_sale',
    {
      title: 'Create Sale',
      description:
        'Register a sale (clientes_vendas). Required: cliente_id, value, sold_at. ' +
        'Optional: notes, broker_id, user_id, cpf, property_type, builder_name, ' +
        'block, unit, payment_method, commission, bonus, total_commission, development_name.',
      inputSchema: {
        cliente_id: z.number().describe('Client ID'),
        value: z.number().describe('Sale value'),
        sold_at: z.string().describe('Sale timestamp (ISO 8601)'),
        notes: z.string().optional().describe('Notes'),
        broker_id: z.number().optional().describe('Closing broker'),
        user_id: z.number().optional().describe('Creator user ID'),
        cpf: z.string().optional().describe('Client CPF'),
        property_type: z.string().optional().describe('Property type'),
        builder_name: z.string().optional().describe('Builder/construtora name'),
        block: z.string().optional().describe('Block (bloco)'),
        unit: z.string().optional().describe('Unit (unidade)'),
        payment_method: z.string().optional().describe('Payment method'),
        commission: z.number().optional().describe('Commission value'),
        bonus: z.number().optional().describe('Bonus'),
        total_commission: z.number().optional().describe('Total commission'),
        development_name: z.string().optional().describe('Development name'),
      },
    },
    async ({ cliente_id, value, sold_at, notes, broker_id, user_id, cpf, property_type, builder_name, block, unit, payment_method, commission, bonus, total_commission, development_name }) => {
      try {
        const sql = `
          INSERT INTO clientes_vendas
            (cliente_id, value, sold_at, notes, broker_id, user_id, cpf, property_type, builder_name,
             block, unit, payment_method, commission, bonus, total_commission, development_name, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
          RETURNING *
        `;
        const params = [
          cliente_id, value, sold_at,
          notes ?? null, broker_id ?? null, user_id ?? null,
          cpf ?? null, property_type ?? null, builder_name ?? null,
          block ?? null, unit ?? null, payment_method ?? null,
          commission ?? null, bonus ?? null, total_commission ?? null, development_name ?? null,
        ];
        const result = await query(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify({ created: result.rows[0] }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error creating sale: ${msg}` }], isError: true };
      }
    }
  );

  // 11. sales_report - Aggregate sales report
  server.registerTool(
    'sales_report',
    {
      title: 'Sales Report',
      description:
        'Generate a sales report: total value, commission, and total_commission grouped by broker. Optional filters by broker, date range.',
      inputSchema: {
        broker_id: z.number().optional().describe('Filter by broker ID'),
        date_from: z.string().optional().describe('Filter from date (ISO string, based on sold_at)'),
        date_to: z.string().optional().describe('Filter to date (ISO string, based on sold_at)'),
      },
    },
    async ({ broker_id, date_from, date_to }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (broker_id !== undefined) {
          conditions.push(`v.broker_id = $${idx}`);
          params.push(broker_id);
          idx++;
        }
        if (date_from) {
          conditions.push(`v.sold_at >= $${idx}`);
          params.push(date_from);
          idx++;
        }
        if (date_to) {
          conditions.push(`v.sold_at <= $${idx}`);
          params.push(date_to);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT
            v.broker_id,
            u.full_name AS broker_name,
            COUNT(*)::int AS sales_count,
            SUM(v.value)::numeric AS total_value,
            SUM(v.commission)::numeric AS total_commission_fee,
            SUM(v.bonus)::numeric AS total_bonus,
            SUM(v.total_commission)::numeric AS total_commission
          FROM clientes_vendas v
          LEFT JOIN sistema_users u ON v.broker_id = u.id
          ${where}
          GROUP BY v.broker_id, u.full_name
          ORDER BY total_value DESC
        `;

        const result = await query(sql, params);

        const totals = await query(
          `SELECT
             COUNT(*)::int AS total_sales,
             COALESCE(SUM(v.value), 0)::numeric AS grand_total_value,
             COALESCE(SUM(v.commission), 0)::numeric AS grand_total_commission_fee,
             COALESCE(SUM(v.total_commission), 0)::numeric AS grand_total_commission
           FROM clientes_vendas v
           ${where}`,
          params
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  by_broker: result.rows,
                  totals: totals.rows[0],
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error generating sales report: ${msg}` }], isError: true };
      }
    }
  );
}
