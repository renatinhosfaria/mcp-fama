import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

// Standard select for a reminder with joins
const REMINDER_SELECT = `
  r.id, r.appointment_id, r.template_id, r.template_key,
  r.title, r.message, r.channel, r.status, r.status_reason,
  r.recipient_type, r.recipient_user_id,
  r.recipient_client_id,
  r.entity_type, r.entity_id,
  r.scheduled_for, r.sent_at, r.failed_at, r.skipped_at, r.cancelled_at,
  r.retry_count, r.last_error,
  r.offset_minutes, r.idempotency_key,
  r.channels_sent, r.metadata,
  r.locked_at, r.locked_by,
  r.created_by_user_id, r.created_at, r.updated_at,
  ru.full_name AS recipient_user_name,
  rc.full_name AS recipient_client_name,
  cb.full_name AS created_by_name
`;

const REMINDER_JOINS = `
  LEFT JOIN sistema_users ru ON r.recipient_user_id = ru.id
  LEFT JOIN clientes rc ON r.recipient_client_id = rc.id
  LEFT JOIN sistema_users cb ON r.created_by_user_id = cb.id
`;

function buildIdempotencyKey(args: {
  entity_type?: string | null;
  entity_id?: number | null;
  appointment_id?: number | null;
  recipient_type?: string | null;
  recipient_user_id?: number | null;
  recipient_client_id?: number | null;
  template_key?: string | null;
  channel?: string | null;
}): string | null {
  const entType = args.entity_type ?? (args.appointment_id ? 'appointment' : null);
  const entId = args.entity_id ?? args.appointment_id ?? null;
  const recType = args.recipient_type ?? 'user';
  const recId = args.recipient_user_id ?? args.recipient_client_id ?? null;
  if (!entType || !entId || !recId || !args.template_key || !args.channel) return null;
  return `${entType}:${entId}:recipient:${recType}:${recId}:${args.template_key}:${args.channel}`;
}

export function registerRemindersTools(server: McpServer) {
  // 1. list_reminders - List reminders with rich filters
  server.registerTool(
    'list_reminders',
    {
      title: 'List Reminders',
      description:
        'List reminder records (reminders) with filters: status (Pending/Processing/Sent/Failed/Cancelled/Skipped), ' +
        'channel, recipient, entity, appointment, upcoming/overdue. Sorted by scheduled_for ASC.',
      inputSchema: {
        status: z.string().optional().describe('Filter by status'),
        channel: z.string().optional().describe('Filter by channel'),
        recipient_user_id: z.number().optional().describe('Filter by recipient user'),
        recipient_client_id: z.number().optional().describe('Filter by recipient client'),
        entity_type: z.string().optional().describe('Filter by entity_type'),
        entity_id: z.number().optional().describe('Filter by entity_id'),
        appointment_id: z.number().optional().describe('Filter by appointment_id'),
        upcoming_only: z.boolean().optional().default(false).describe('Only scheduled in the future'),
        overdue_only: z.boolean().optional().default(false).describe('Only Pending and past scheduled_for'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
        offset: z.number().optional().default(0).describe('Offset'),
      },
    },
    async (a) => {
      try {
        const c: string[] = [];
        const p: unknown[] = [];
        let i = 1;
        if (a.status) { c.push(`r.status = $${i}`); p.push(a.status); i++; }
        if (a.channel) { c.push(`r.channel = $${i}`); p.push(a.channel); i++; }
        if (a.recipient_user_id !== undefined) { c.push(`r.recipient_user_id = $${i}`); p.push(a.recipient_user_id); i++; }
        if (a.recipient_client_id !== undefined) { c.push(`r.recipient_client_id = $${i}`); p.push(a.recipient_client_id); i++; }
        if (a.entity_type) { c.push(`r.entity_type = $${i}`); p.push(a.entity_type); i++; }
        if (a.entity_id !== undefined) { c.push(`r.entity_id = $${i}`); p.push(a.entity_id); i++; }
        if (a.appointment_id !== undefined) { c.push(`r.appointment_id = $${i}`); p.push(a.appointment_id); i++; }
        if (a.upcoming_only) c.push(`r.scheduled_for > NOW()`);
        if (a.overdue_only) c.push(`r.status = 'Pending' AND r.scheduled_for < NOW()`);

        const where = c.length > 0 ? `WHERE ${c.join(' AND ')}` : '';
        p.push(a.limit ?? 50); const li = i++;
        p.push(a.offset ?? 0); const oi = i++;
        const sql = `SELECT ${REMINDER_SELECT} FROM reminders r ${REMINDER_JOINS} ${where} ORDER BY r.scheduled_for ASC LIMIT $${li} OFFSET $${oi}`;
        const result = await query(sql, p);
        return { content: [{ type: 'text', text: JSON.stringify({ count: result.rowCount, reminders: result.rows }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing reminders: ${msg}` }], isError: true };
      }
    }
  );

  // 2. get_reminder - Single reminder with delivery logs
  server.registerTool(
    'get_reminder',
    {
      title: 'Get Reminder',
      description: 'Get a single reminder by ID with related notification_logs (delivery attempts).',
      inputSchema: {
        reminder_id: z.number().describe('Reminder ID'),
      },
    },
    async ({ reminder_id }) => {
      try {
        const [reminderRes, logsRes] = await Promise.all([
          query(`SELECT ${REMINDER_SELECT} FROM reminders r ${REMINDER_JOINS} WHERE r.id = $1`, [reminder_id]),
          query(
            `SELECT id, channel, status, provider, attempt_number, provider_message_id,
                    sent_at, error_message, metadata
             FROM notification_logs WHERE reminder_id = $1 ORDER BY sent_at ASC`,
            [reminder_id]
          ),
        ]);
        if (reminderRes.rows.length === 0) {
          return { content: [{ type: 'text', text: `Reminder ${reminder_id} not found.` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ reminder: reminderRes.rows[0], delivery_logs: logsRes.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching reminder: ${msg}` }], isError: true };
      }
    }
  );

  // 3. create_reminder - Insert a new reminder
  server.registerTool(
    'create_reminder',
    {
      title: 'Create Reminder',
      description:
        'Insert a single reminder. Required: title, message, scheduled_for, channel (default "internal"), and a recipient ' +
        '(recipient_user_id or recipient_client_id). If idempotency_key is omitted, one is auto-built using the ' +
        'convention "{entity_type}:{entity_id}:recipient:{recipient_type}:{recipient_id}:{template_key}:{channel}". ' +
        'A unique partial index on idempotency_key prevents duplicates while status IN (Pending,Processing). ' +
        'Set on_conflict="ignore" to silently skip duplicates.',
      inputSchema: {
        title: z.string().describe('Title'),
        message: z.string().describe('Message body'),
        scheduled_for: z.string().describe('When to send (ISO 8601)'),
        channel: z.string().optional().default('internal').describe('Delivery channel (internal, whatsapp, push, ...)'),
        recipient_type: z.enum(['user', 'client']).optional().default('user').describe('Recipient type'),
        recipient_user_id: z.number().optional().describe('Recipient user ID (for recipient_type=user)'),
        recipient_client_id: z.number().optional().describe('Recipient client ID (for recipient_type=client)'),
        appointment_id: z.number().optional().describe('Linked appointment'),
        entity_type: z.string().optional().describe('Linked entity_type (defaults to "appointment" if appointment_id is set)'),
        entity_id: z.number().optional().describe('Linked entity_id'),
        template_id: z.number().optional().describe('Reminder template ID'),
        template_key: z.string().optional().describe('Reminder template key'),
        offset_minutes: z.number().optional().describe('Offset minutes vs base time (negative = before)'),
        idempotency_key: z.string().optional().describe('Override idempotency key (auto if omitted)'),
        created_by_user_id: z.number().optional().describe('Author user ID'),
        metadata: z.record(z.unknown()).optional().describe('Free-form metadata JSONB'),
        on_conflict: z.enum(['error', 'ignore']).optional().default('error').describe('On idempotency conflict: error or ignore'),
      },
    },
    async (a) => {
      try {
        if (!a.recipient_user_id && !a.recipient_client_id) {
          return { content: [{ type: 'text', text: 'recipient_user_id or recipient_client_id is required.' }], isError: true };
        }
        const entityType = a.entity_type ?? (a.appointment_id ? 'appointment' : null);
        const entityId = a.entity_id ?? a.appointment_id ?? null;
        const idemKey = a.idempotency_key ?? buildIdempotencyKey({
          entity_type: entityType,
          entity_id: entityId,
          appointment_id: a.appointment_id ?? null,
          recipient_type: a.recipient_type,
          recipient_user_id: a.recipient_user_id,
          recipient_client_id: a.recipient_client_id,
          template_key: a.template_key,
          channel: a.channel,
        });

        const onConflict = a.on_conflict === 'ignore'
          ? `ON CONFLICT (idempotency_key) WHERE status = ANY (ARRAY['Pending','Processing']) AND idempotency_key IS NOT NULL DO NOTHING`
          : '';

        const sql = `
          INSERT INTO reminders (
            title, message, scheduled_for, channel, status,
            recipient_type, recipient_user_id, recipient_client_id,
            appointment_id, entity_type, entity_id,
            template_id, template_key, offset_minutes,
            idempotency_key, created_by_user_id, metadata,
            created_at, updated_at
          )
          VALUES (
            $1, $2, $3, COALESCE($4, 'internal'), 'Pending',
            COALESCE($5, 'user'), $6, $7,
            $8, $9, $10,
            $11, $12, $13,
            $14, $15, COALESCE($16, '{}'::jsonb),
            NOW(), NOW()
          )
          ${onConflict}
          RETURNING *
        `;
        const result = await query(sql, [
          a.title, a.message, a.scheduled_for, a.channel ?? null,
          a.recipient_type ?? null, a.recipient_user_id ?? null, a.recipient_client_id ?? null,
          a.appointment_id ?? null, entityType, entityId,
          a.template_id ?? null, a.template_key ?? null, a.offset_minutes ?? null,
          idemKey, a.created_by_user_id ?? null,
          a.metadata ? JSON.stringify(a.metadata) : null,
        ]);

        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ skipped: true, reason: 'idempotency conflict', idempotency_key: idemKey }, null, 2) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ created: result.rows[0] }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error creating reminder: ${msg}` }], isError: true };
      }
    }
  );

  // 4. update_reminder - Dynamic update of mutable fields
  server.registerTool(
    'update_reminder',
    {
      title: 'Update Reminder',
      description:
        'Update a reminder with a dynamic SET clause. Only mutable fields (title, message, scheduled_for, channel, ' +
        'status, recipient_*, metadata, status_reason) are allowed.',
      inputSchema: {
        reminder_id: z.number().describe('Reminder ID'),
        title: z.string().optional(),
        message: z.string().optional(),
        scheduled_for: z.string().optional().describe('ISO 8601'),
        channel: z.string().optional(),
        status: z.string().optional(),
        status_reason: z.string().optional(),
        recipient_type: z.enum(['user', 'client']).optional(),
        recipient_user_id: z.number().optional(),
        recipient_client_id: z.number().optional(),
        offset_minutes: z.number().optional(),
        metadata: z.record(z.unknown()).optional().describe('Replace metadata JSONB'),
      },
    },
    async (a) => {
      try {
        const setC: string[] = [];
        const p: unknown[] = [];
        let i = 1;
        const fields: Array<[string, unknown, boolean?]> = [
          ['title', a.title], ['message', a.message], ['scheduled_for', a.scheduled_for],
          ['channel', a.channel], ['status', a.status], ['status_reason', a.status_reason],
          ['recipient_type', a.recipient_type], ['recipient_user_id', a.recipient_user_id],
          ['recipient_client_id', a.recipient_client_id], ['offset_minutes', a.offset_minutes],
          ['metadata', a.metadata ? JSON.stringify(a.metadata) : undefined, true],
        ];
        for (const [k, v, jsonb] of fields) {
          if (v !== undefined) {
            setC.push(jsonb ? `${k} = $${i}::jsonb` : `${k} = $${i}`);
            p.push(v);
            i++;
          }
        }
        if (setC.length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };
        }
        setC.push(`updated_at = NOW()`);
        p.push(a.reminder_id);
        const sql = `UPDATE reminders SET ${setC.join(', ')} WHERE id = $${i} RETURNING *`;
        const result = await query(sql, p);
        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: `Reminder ${a.reminder_id} not found.` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ updated: result.rows[0] }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error updating reminder: ${msg}` }], isError: true };
      }
    }
  );

  // 5. cancel_reminder - Mark a reminder as cancelled
  server.registerTool(
    'cancel_reminder',
    {
      title: 'Cancel Reminder',
      description: 'Cancel a single reminder (status=Cancelled, cancelled_at=NOW()). Only Pending/Processing reminders are cancelled.',
      inputSchema: {
        reminder_id: z.number().describe('Reminder ID'),
        reason: z.string().optional().describe('Optional cancellation reason (stored in status_reason)'),
      },
    },
    async ({ reminder_id, reason }) => {
      try {
        const result = await query(
          `UPDATE reminders
           SET status = 'Cancelled', cancelled_at = NOW(), status_reason = COALESCE($2, status_reason),
               locked_at = NULL, locked_by = NULL, updated_at = NOW()
           WHERE id = $1 AND status IN ('Pending','Processing')
           RETURNING *`,
          [reminder_id, reason ?? null]
        );
        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: `Reminder ${reminder_id} not found or not cancellable (already terminal status).` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ cancelled: result.rows[0] }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error cancelling reminder: ${msg}` }], isError: true };
      }
    }
  );

  // 6. list_entity_reminders - All reminders for an entity (or appointment)
  server.registerTool(
    'list_entity_reminders',
    {
      title: 'List Entity Reminders',
      description:
        'List all reminders linked to an entity. Provide either (entity_type+entity_id) or appointment_id. ' +
        'Optional status filter and active_only shortcut (Pending+Processing).',
      inputSchema: {
        entity_type: z.string().optional().describe('Entity type (e.g. "appointment")'),
        entity_id: z.number().optional().describe('Entity ID'),
        appointment_id: z.number().optional().describe('Shortcut for appointment reminders'),
        status: z.string().optional().describe('Filter by status'),
        active_only: z.boolean().optional().default(false).describe('Pending+Processing only'),
        limit: z.number().optional().default(50),
      },
    },
    async (a) => {
      try {
        if (!a.appointment_id && (!a.entity_type || a.entity_id === undefined)) {
          return { content: [{ type: 'text', text: 'Provide appointment_id, or entity_type AND entity_id.' }], isError: true };
        }
        const c: string[] = [];
        const p: unknown[] = [];
        let i = 1;
        if (a.appointment_id !== undefined) {
          c.push(`r.appointment_id = $${i}`); p.push(a.appointment_id); i++;
        }
        if (a.entity_type) { c.push(`r.entity_type = $${i}`); p.push(a.entity_type); i++; }
        if (a.entity_id !== undefined) { c.push(`r.entity_id = $${i}`); p.push(a.entity_id); i++; }
        if (a.active_only) c.push(`r.status IN ('Pending','Processing')`);
        else if (a.status) { c.push(`r.status = $${i}`); p.push(a.status); i++; }

        p.push(a.limit ?? 50);
        const li = i;
        const sql = `
          SELECT ${REMINDER_SELECT} FROM reminders r ${REMINDER_JOINS}
          WHERE ${c.join(' AND ')}
          ORDER BY r.scheduled_for ASC
          LIMIT $${li}
        `;
        const result = await query(sql, p);
        return { content: [{ type: 'text', text: JSON.stringify({ count: result.rowCount, reminders: result.rows }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing entity reminders: ${msg}` }], isError: true };
      }
    }
  );

  // 7. create_entity_reminders - Bulk create reminders from templates for an entity
  server.registerTool(
    'create_entity_reminders',
    {
      title: 'Create Entity Reminders',
      description:
        'Bulk-create reminders for an entity from reminder_templates. For each selected template, ' +
        'computes scheduled_for = base_time + (offset_minutes || \'minutes\') and inserts a reminder. ' +
        'Idempotency key auto-built; existing Pending/Processing duplicates are skipped (ON CONFLICT DO NOTHING). ' +
        'Defaults to all is_active+is_default templates filtered by channel(s).',
      inputSchema: {
        base_time: z.string().describe('Reference timestamp the offsets are applied to (ISO 8601)'),
        recipient_type: z.enum(['user', 'client']).optional().default('user'),
        recipient_user_id: z.number().optional().describe('Recipient user ID (when recipient_type=user)'),
        recipient_client_id: z.number().optional().describe('Recipient client ID (when recipient_type=client)'),
        appointment_id: z.number().optional().describe('Appointment ID to link (sets entity_type=appointment, entity_id=appointment_id)'),
        entity_type: z.string().optional().describe('Custom entity_type if not appointment'),
        entity_id: z.number().optional().describe('Custom entity_id'),
        template_keys: z.array(z.string()).optional().describe('Specific template keys to use (default: all is_active+is_default)'),
        channels: z.array(z.string()).optional().describe('Filter templates by channel (default: all)'),
        created_by_user_id: z.number().optional(),
        metadata: z.record(z.unknown()).optional().describe('Metadata applied to every created reminder'),
      },
    },
    async (a) => {
      try {
        if (!a.recipient_user_id && !a.recipient_client_id) {
          return { content: [{ type: 'text', text: 'recipient_user_id or recipient_client_id is required.' }], isError: true };
        }
        const entType = a.entity_type ?? (a.appointment_id ? 'appointment' : null);
        const entId = a.entity_id ?? a.appointment_id ?? null;
        if (!entType || !entId) {
          return { content: [{ type: 'text', text: 'Provide appointment_id, or entity_type AND entity_id.' }], isError: true };
        }

        const tplFilter: string[] = ['is_active = true', 'is_default = true'];
        const tplParams: unknown[] = [];
        let ti = 1;
        if (a.template_keys && a.template_keys.length > 0) {
          tplFilter.length = 0;
          tplFilter.push(`is_active = true`);
          tplFilter.push(`key = ANY($${ti}::text[])`);
          tplParams.push(a.template_keys);
          ti++;
        }
        if (a.channels && a.channels.length > 0) {
          tplFilter.push(`channel = ANY($${ti}::text[])`);
          tplParams.push(a.channels);
          ti++;
        }
        const tplRes = await query(
          `SELECT id, key, channel, offset_minutes, default_title, default_message
           FROM reminder_templates WHERE ${tplFilter.join(' AND ')}
           ORDER BY offset_minutes DESC`,
          tplParams
        );

        if (tplRes.rows.length === 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ created: [], skipped: [], reason: 'No templates matched the filters.' }, null, 2) }] };
        }

        const created: unknown[] = [];
        const skipped: unknown[] = [];
        const recType = a.recipient_type ?? 'user';
        const recId = a.recipient_user_id ?? a.recipient_client_id;
        const metadataJson = a.metadata ? JSON.stringify(a.metadata) : null;

        for (const tpl of tplRes.rows) {
          const idemKey = `${entType}:${entId}:recipient:${recType}:${recId}:${tpl.key}:${tpl.channel}`;
          const sql = `
            INSERT INTO reminders (
              title, message, scheduled_for, channel, status,
              recipient_type, recipient_user_id, recipient_client_id,
              appointment_id, entity_type, entity_id,
              template_id, template_key, offset_minutes,
              idempotency_key, created_by_user_id, metadata,
              created_at, updated_at
            )
            VALUES (
              $1, $2, ($3::timestamp + ($4 || ' minutes')::interval), $5, 'Pending',
              $6, $7, $8,
              $9, $10, $11,
              $12, $13, $14,
              $15, $16, COALESCE($17::jsonb, '{}'::jsonb),
              NOW(), NOW()
            )
            ON CONFLICT (idempotency_key) WHERE status = ANY (ARRAY['Pending','Processing']) AND idempotency_key IS NOT NULL DO NOTHING
            RETURNING id, title, scheduled_for, channel, status, idempotency_key
          `;
          const ins = await query(sql, [
            tpl.default_title, tpl.default_message, a.base_time, String(tpl.offset_minutes), tpl.channel,
            recType, a.recipient_user_id ?? null, a.recipient_client_id ?? null,
            a.appointment_id ?? null, entType, entId,
            tpl.id, tpl.key, tpl.offset_minutes,
            idemKey, a.created_by_user_id ?? null, metadataJson,
          ]);
          if (ins.rows.length > 0) created.push(ins.rows[0]);
          else skipped.push({ template_key: tpl.key, channel: tpl.channel, idempotency_key: idemKey });
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ created_count: created.length, skipped_count: skipped.length, created, skipped }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error creating entity reminders: ${msg}` }], isError: true };
      }
    }
  );

  // 8. reschedule_entity_reminders - Re-anchor scheduled_for using new base_time
  server.registerTool(
    'reschedule_entity_reminders',
    {
      title: 'Reschedule Entity Reminders',
      description:
        'Recompute scheduled_for for all Pending reminders of an entity using a new base_time + their offset_minutes. ' +
        'Useful when the parent appointment is moved.',
      inputSchema: {
        new_base_time: z.string().describe('New reference timestamp (ISO 8601)'),
        appointment_id: z.number().optional(),
        entity_type: z.string().optional(),
        entity_id: z.number().optional(),
        only_active: z.boolean().optional().default(true).describe('Only Pending+Processing (default true)'),
      },
    },
    async (a) => {
      try {
        if (!a.appointment_id && (!a.entity_type || a.entity_id === undefined)) {
          return { content: [{ type: 'text', text: 'Provide appointment_id, or entity_type AND entity_id.' }], isError: true };
        }
        const c: string[] = [];
        const p: unknown[] = [a.new_base_time];
        let i = 2;
        if (a.appointment_id !== undefined) { c.push(`appointment_id = $${i}`); p.push(a.appointment_id); i++; }
        if (a.entity_type) { c.push(`entity_type = $${i}`); p.push(a.entity_type); i++; }
        if (a.entity_id !== undefined) { c.push(`entity_id = $${i}`); p.push(a.entity_id); i++; }
        if (a.only_active !== false) c.push(`status IN ('Pending','Processing')`);
        c.push(`offset_minutes IS NOT NULL`);

        const sql = `
          UPDATE reminders
          SET scheduled_for = $1::timestamp + (offset_minutes || ' minutes')::interval,
              updated_at = NOW()
          WHERE ${c.join(' AND ')}
          RETURNING id, scheduled_for, offset_minutes, status
        `;
        const result = await query(sql, p);
        return { content: [{ type: 'text', text: JSON.stringify({ rescheduled_count: result.rowCount, reminders: result.rows }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error rescheduling: ${msg}` }], isError: true };
      }
    }
  );

  // 9. cancel_entity_reminders - Cancel all reminders for an entity
  server.registerTool(
    'cancel_entity_reminders',
    {
      title: 'Cancel Entity Reminders',
      description:
        'Cancel all Pending/Processing reminders for an entity. Provide appointment_id, or entity_type+entity_id.',
      inputSchema: {
        appointment_id: z.number().optional(),
        entity_type: z.string().optional(),
        entity_id: z.number().optional(),
        reason: z.string().optional().describe('Cancellation reason (status_reason)'),
      },
    },
    async (a) => {
      try {
        if (!a.appointment_id && (!a.entity_type || a.entity_id === undefined)) {
          return { content: [{ type: 'text', text: 'Provide appointment_id, or entity_type AND entity_id.' }], isError: true };
        }
        const c: string[] = [`status IN ('Pending','Processing')`];
        const p: unknown[] = [a.reason ?? null];
        let i = 2;
        if (a.appointment_id !== undefined) { c.push(`appointment_id = $${i}`); p.push(a.appointment_id); i++; }
        if (a.entity_type) { c.push(`entity_type = $${i}`); p.push(a.entity_type); i++; }
        if (a.entity_id !== undefined) { c.push(`entity_id = $${i}`); p.push(a.entity_id); i++; }

        const sql = `
          UPDATE reminders
          SET status = 'Cancelled', cancelled_at = NOW(),
              status_reason = COALESCE($1, status_reason),
              locked_at = NULL, locked_by = NULL, updated_at = NOW()
          WHERE ${c.join(' AND ')}
          RETURNING id, status, cancelled_at
        `;
        const result = await query(sql, p);
        return { content: [{ type: 'text', text: JSON.stringify({ cancelled_count: result.rowCount, reminders: result.rows }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error cancelling entity reminders: ${msg}` }], isError: true };
      }
    }
  );

  // 10. claim_next_due_reminder - Worker: atomically lock next due reminder
  server.registerTool(
    'claim_next_due_reminder',
    {
      title: 'Claim Next Due Reminder',
      description:
        'Worker pattern: atomically pick the next due Pending reminder (scheduled_for <= NOW()), mark it Processing ' +
        'and set locked_at/locked_by. Uses FOR UPDATE SKIP LOCKED so multiple workers can run safely. ' +
        'Returns null when nothing is due. Filters by channel(s) and worker_id.',
      inputSchema: {
        worker_id: z.string().describe('Worker identifier (stored in locked_by)'),
        channels: z.array(z.string()).optional().describe('Only consider these channels'),
        max_lock_minutes: z.number().optional().default(5).describe('Treat existing locks older than N minutes as expired (default 5)'),
      },
    },
    async ({ worker_id, channels, max_lock_minutes }) => {
      try {
        const channelFilter = channels && channels.length > 0 ? `AND channel = ANY($3::text[])` : '';
        const params: unknown[] = [worker_id, max_lock_minutes ?? 5];
        if (channels && channels.length > 0) params.push(channels);

        const sql = `
          UPDATE reminders
          SET status = 'Processing',
              locked_at = NOW(),
              locked_by = $1,
              updated_at = NOW()
          WHERE id = (
            SELECT id FROM reminders
            WHERE status = 'Pending'
              AND scheduled_for <= NOW()
              AND (locked_at IS NULL OR locked_at < NOW() - (INTERVAL '1 minute' * $2))
              ${channelFilter}
            ORDER BY scheduled_for ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING *
        `;
        const result = await query(sql, params);
        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ claimed: null }, null, 2) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ claimed: result.rows[0] }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error claiming reminder: ${msg}` }], isError: true };
      }
    }
  );

  // 11. mark_reminder_sent - Worker callback on success
  server.registerTool(
    'mark_reminder_sent',
    {
      title: 'Mark Reminder Sent',
      description:
        'Mark a reminder as Sent (sets sent_at, releases lock, appends channel to channels_sent). ' +
        'Also writes a notification_logs row (status=sent).',
      inputSchema: {
        reminder_id: z.number().describe('Reminder ID'),
        channel: z.string().optional().describe('Override channel for the log row (defaults to reminder.channel)'),
        provider: z.string().optional().default('famachat').describe('Notification provider'),
        provider_message_id: z.string().optional().describe('External message ID'),
        attempt_number: z.number().optional().default(1),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (a) => {
      try {
        const upd = await query(
          `UPDATE reminders
           SET status = 'Sent', sent_at = NOW(),
               channels_sent = COALESCE(channels_sent, '[]'::jsonb) || jsonb_build_array(COALESCE($2, channel)),
               locked_at = NULL, locked_by = NULL,
               last_error = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [a.reminder_id, a.channel ?? null]
        );
        if (upd.rows.length === 0) {
          return { content: [{ type: 'text', text: `Reminder ${a.reminder_id} not found.` }], isError: true };
        }
        const r = upd.rows[0];
        await query(
          `INSERT INTO notification_logs (reminder_id, channel, status, provider, attempt_number, provider_message_id, sent_at, metadata, created_at)
           VALUES ($1, $2, 'sent', COALESCE($3, 'famachat'), COALESCE($4, 1), $5, NOW(), COALESCE($6::jsonb, '{}'::jsonb), NOW())`,
          [a.reminder_id, a.channel ?? r.channel, a.provider ?? null, a.attempt_number ?? null, a.provider_message_id ?? null,
           a.metadata ? JSON.stringify(a.metadata) : null]
        );
        return { content: [{ type: 'text', text: JSON.stringify({ sent: r }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error marking reminder sent: ${msg}` }], isError: true };
      }
    }
  );

  // 12. mark_reminder_failed - Worker callback on failure
  server.registerTool(
    'mark_reminder_failed',
    {
      title: 'Mark Reminder Failed',
      description:
        'Record a delivery failure. Increments retry_count and stores last_error. If retry_count >= max_retries ' +
        'transitions to Failed (failed_at = NOW()), otherwise returns to Pending so the worker can retry. ' +
        'Also writes a notification_logs row (status=failed).',
      inputSchema: {
        reminder_id: z.number().describe('Reminder ID'),
        error_message: z.string().describe('Error message'),
        max_retries: z.number().optional().default(3).describe('Max retries before terminal Failed (default 3)'),
        channel: z.string().optional(),
        provider: z.string().optional().default('famachat'),
        attempt_number: z.number().optional(),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (a) => {
      try {
        const upd = await query(
          `UPDATE reminders
           SET retry_count = COALESCE(retry_count, 0) + 1,
               last_error = $2,
               status = CASE WHEN COALESCE(retry_count, 0) + 1 >= $3 THEN 'Failed' ELSE 'Pending' END,
               failed_at = CASE WHEN COALESCE(retry_count, 0) + 1 >= $3 THEN NOW() ELSE failed_at END,
               locked_at = NULL, locked_by = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [a.reminder_id, a.error_message, a.max_retries ?? 3]
        );
        if (upd.rows.length === 0) {
          return { content: [{ type: 'text', text: `Reminder ${a.reminder_id} not found.` }], isError: true };
        }
        const r = upd.rows[0];
        const attemptNumber = a.attempt_number ?? r.retry_count ?? 1;
        await query(
          `INSERT INTO notification_logs (reminder_id, channel, status, provider, attempt_number, sent_at, error_message, metadata, created_at)
           VALUES ($1, $2, 'failed', COALESCE($3, 'famachat'), $4, NOW(), $5, COALESCE($6::jsonb, '{}'::jsonb), NOW())`,
          [a.reminder_id, a.channel ?? r.channel, a.provider ?? null,
           attemptNumber, a.error_message,
           a.metadata ? JSON.stringify(a.metadata) : null]
        );
        return { content: [{ type: 'text', text: JSON.stringify({ failed: r }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error marking reminder failed: ${msg}` }], isError: true };
      }
    }
  );

  // 13. mark_reminder_skipped - Worker callback when delivery should be skipped
  server.registerTool(
    'mark_reminder_skipped',
    {
      title: 'Mark Reminder Skipped',
      description:
        'Mark a reminder as Skipped (terminal). Use when policy decides not to deliver (e.g. user unsubscribed, ' +
        'past quiet hours, parent appointment cancelled). Releases the lock.',
      inputSchema: {
        reminder_id: z.number().describe('Reminder ID'),
        reason: z.string().describe('Reason (stored in status_reason)'),
        channel: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const upd = await query(
          `UPDATE reminders
           SET status = 'Skipped', skipped_at = NOW(),
               status_reason = $2,
               locked_at = NULL, locked_by = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [a.reminder_id, a.reason]
        );
        if (upd.rows.length === 0) {
          return { content: [{ type: 'text', text: `Reminder ${a.reminder_id} not found.` }], isError: true };
        }
        const r = upd.rows[0];
        await query(
          `INSERT INTO notification_logs (reminder_id, channel, status, provider, attempt_number, sent_at, error_message, metadata, created_at)
           VALUES ($1, $2, 'skipped', 'famachat', 1, NOW(), $3, '{}'::jsonb, NOW())`,
          [a.reminder_id, a.channel ?? r.channel, a.reason]
        );
        return { content: [{ type: 'text', text: JSON.stringify({ skipped: r }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error marking reminder skipped: ${msg}` }], isError: true };
      }
    }
  );

  // 14. release_stuck_reminders - Cleanup hung locks
  server.registerTool(
    'release_stuck_reminders',
    {
      title: 'Release Stuck Reminders',
      description:
        'Release reminders whose Processing lock is older than max_lock_minutes (default 10). ' +
        'Sets status back to Pending so the next worker can pick them up. Returns the released rows.',
      inputSchema: {
        max_lock_minutes: z.number().optional().default(10).describe('Threshold in minutes (default 10)'),
        worker_id: z.string().optional().describe('Only release locks held by this worker_id'),
      },
    },
    async ({ max_lock_minutes, worker_id }) => {
      try {
        const params: unknown[] = [max_lock_minutes ?? 10];
        let workerFilter = '';
        if (worker_id) {
          params.push(worker_id);
          workerFilter = `AND locked_by = $2`;
        }
        const sql = `
          UPDATE reminders
          SET status = 'Pending',
              locked_at = NULL,
              locked_by = NULL,
              updated_at = NOW(),
              status_reason = COALESCE(status_reason, 'released stuck lock')
          WHERE status = 'Processing'
            AND locked_at IS NOT NULL
            AND locked_at < NOW() - (INTERVAL '1 minute' * $1)
            ${workerFilter}
          RETURNING id, scheduled_for, retry_count, locked_by
        `;
        const result = await query(sql, params);
        return { content: [{ type: 'text', text: JSON.stringify({ released_count: result.rowCount, reminders: result.rows }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error releasing stuck reminders: ${msg}` }], isError: true };
      }
    }
  );

  // Bonus: list_reminder_templates - kept (already useful for create_entity_reminders callers)
  server.registerTool(
    'list_reminder_templates',
    {
      title: 'List Reminder Templates',
      description: 'List reminder templates with key, default title/message, channel, offset_minutes, active flag.',
      inputSchema: {
        active_only: z.boolean().optional().default(true),
        channel: z.string().optional(),
      },
    },
    async ({ active_only, channel }) => {
      try {
        const c: string[] = [];
        const p: unknown[] = [];
        let i = 1;
        if (active_only) c.push(`is_active = true`);
        if (channel) { c.push(`channel = $${i}`); p.push(channel); i++; }
        const where = c.length > 0 ? `WHERE ${c.join(' AND ')}` : '';
        const sql = `
          SELECT id, key, name, description, default_title, default_message,
                 channel, offset_minutes, is_default, is_active, version,
                 created_at, updated_at
          FROM reminder_templates ${where}
          ORDER BY offset_minutes DESC NULLS LAST, key
        `;
        const result = await query(sql, p);
        return { content: [{ type: 'text', text: JSON.stringify({ count: result.rowCount, templates: result.rows }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing templates: ${msg}` }], isError: true };
      }
    }
  );

  // Bonus: notification_logs (delivery audit) - kept
  server.registerTool(
    'notification_logs',
    {
      title: 'Notification Logs',
      description:
        'Show notification delivery logs (notification_logs) for reminders. Filter by reminder_id, channel, ' +
        'status, provider, date range.',
      inputSchema: {
        reminder_id: z.number().optional(),
        channel: z.string().optional(),
        status: z.string().optional(),
        provider: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        limit: z.number().optional().default(50),
      },
    },
    async (a) => {
      try {
        const c: string[] = [];
        const p: unknown[] = [];
        let i = 1;
        if (a.reminder_id !== undefined) { c.push(`l.reminder_id = $${i}`); p.push(a.reminder_id); i++; }
        if (a.channel) { c.push(`l.channel = $${i}`); p.push(a.channel); i++; }
        if (a.status) { c.push(`l.status = $${i}`); p.push(a.status); i++; }
        if (a.provider) { c.push(`l.provider = $${i}`); p.push(a.provider); i++; }
        if (a.date_from) { c.push(`l.sent_at >= $${i}`); p.push(a.date_from); i++; }
        if (a.date_to) { c.push(`l.sent_at <= $${i}`); p.push(a.date_to); i++; }
        const where = c.length > 0 ? `WHERE ${c.join(' AND ')}` : '';
        p.push(a.limit ?? 50);
        const li = i;
        const sql = `
          SELECT l.id, l.reminder_id, l.channel, l.status, l.provider,
                 l.attempt_number, l.provider_message_id, l.sent_at,
                 l.error_message, l.metadata,
                 r.title AS reminder_title, r.recipient_user_id,
                 u.full_name AS recipient_user_name
          FROM notification_logs l
          LEFT JOIN reminders r ON l.reminder_id = r.id
          LEFT JOIN sistema_users u ON r.recipient_user_id = u.id
          ${where}
          ORDER BY l.sent_at DESC
          LIMIT $${li}
        `;
        const result = await query(sql, p);
        return { content: [{ type: 'text', text: JSON.stringify({ count: result.rowCount, logs: result.rows }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching notification logs: ${msg}` }], isError: true };
      }
    }
  );
}
