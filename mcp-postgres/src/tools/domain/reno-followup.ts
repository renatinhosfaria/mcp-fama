import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query, withTransaction } from '../../db.js';

type JsonObject = Record<string, unknown>;
type RenoFlow = 'repescagem' | 'resgate';
type ToolContent = { type: 'text'; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

const RENO_FLOWS = ['repescagem', 'resgate'] as const;
const META_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const DEFAULT_CLAIM_TTL_MINUTES = 10;

function jsonResponse(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResponse(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function requireSafeMetaPath(path: string[]): void {
  if (path.length === 0 || path.length > 8) {
    throw new Error('Invalid meta_data path: expected 1 to 8 segments.');
  }

  for (const segment of path) {
    if (!META_PATH_SEGMENT.test(segment)) {
      throw new Error(`Invalid meta_data path segment: ${segment}`);
    }
  }
}

function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function getFirstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return first.replace(/[.,;:!?]+$/g, '');
}

export function formatRenoTimestamp(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);

  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}T${byType.get('hour')}:${byType.get('minute')}:${byType.get('second')}-03:00`;
}

function isoDateOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return formatRenoTimestamp(value);
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeFlow(value: string): RenoFlow {
  if ((RENO_FLOWS as readonly string[]).includes(value)) {
    return value as RenoFlow;
  }
  throw new Error(`Invalid Reno flow: ${value}`);
}

export function setJsonBranch(metaData: JsonObject | null | undefined, path: string[], data: JsonObject): JsonObject {
  requireSafeMetaPath(path);

  const root = cloneJsonObject(asJsonObject(metaData));
  let cursor = root;

  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    const nextObject = isJsonObject(next) ? cloneJsonObject(next) : {};
    cursor[segment] = nextObject;
    cursor = nextObject;
  }

  cursor[path[path.length - 1]] = cloneJsonObject(data);
  return root;
}

export function getRenoFollowupStateFromMeta(metaData: unknown): {
  repescagem: JsonObject | null;
  resgate: JsonObject | null;
} {
  const root = asJsonObject(metaData);
  const renoFollowup = asJsonObject(root.reno_followup);

  return {
    repescagem: isJsonObject(renoFollowup.repescagem) ? renoFollowup.repescagem : null,
    resgate: isJsonObject(renoFollowup.resgate) ? renoFollowup.resgate : null,
  };
}

export function buildRenoFollowupMessage(args: {
  flow: RenoFlow;
  fullName: string;
  step: number;
  lastContextBucket?: string | null;
}): string {
  const firstName = getFirstName(args.fullName);

  if (args.flow === 'repescagem') {
    if (args.step === 1) {
      return firstName
        ? `Oi, ${firstName}. Ainda faz sentido eu te ajudar com a busca do imóvel?`
        : 'Oi. Ainda faz sentido eu te ajudar com a busca do imóvel?';
    }

    return firstName
      ? `Oi, ${firstName}. Passando para retomar: você ainda quer seguir com a busca do imóvel?`
      : 'Oi. Passando para retomar: você ainda quer seguir com a busca do imóvel?';
  }

  switch (args.lastContextBucket) {
    case 'financiamento_sumiu':
      return firstName
        ? `${firstName}, sobre financiamento, o mais importante é ver se a compra fica viável antes de escolher imóvel. Quer que eu te ajude por esse caminho?`
        : 'Sobre financiamento, o mais importante é ver se a compra fica viável antes de escolher imóvel. Quer que eu te ajude por esse caminho?';
    case 'visita_nao_marcada':
      return 'Acho que para você entender melhor, vale ver isso pessoalmente aqui na Fama. Quer que eu veja um horário simples para você passar aqui?';
    case 'sem_gancho_claro':
    default:
      return firstName
        ? `${firstName}, passando para retomar contigo. Ainda faz sentido continuar olhando essa possibilidade de imóvel?`
        : 'Passando para retomar contigo. Ainda faz sentido continuar olhando essa possibilidade de imóvel?';
  }
}

export function buildRenoSentNoteText(args: {
  flow: RenoFlow;
  step: number;
  message: string;
  nextRunAt: string;
  lastContextBucket?: string | null;
}): string {
  const bucketPart =
    args.flow === 'resgate' && args.lastContextBucket ? ` Bucket: ${args.lastContextBucket}.` : '';

  return `Reno enviou follow-up de ${args.flow} step ${args.step} via WhatsApp.${bucketPart} Mensagem: "${args.message}". Próximo follow-up previsto para ${args.nextRunAt}.`;
}

export function buildRenoFailedNoteText(args: {
  flow: RenoFlow;
  errorSummary: string;
  stoppedReason: string;
}): string {
  return `Reno follow-up de ${args.flow} parado. Motivo: ${args.stoppedReason}. Erro: ${args.errorSummary}. Status preservado.`;
}

async function updateClientMetaDataBranch(args: {
  clientId: number;
  path: string[];
  data: JsonObject;
}) {
  requireSafeMetaPath(args.path);

  const result = await query(
    `UPDATE clientes
       SET meta_data = jsonb_set(COALESCE(meta_data, '{}'::jsonb), $2::text[], $3::jsonb, true),
           updated_at = NOW()
     WHERE id = $1
     RETURNING id AS client_id, meta_data, COALESCE(meta_data->'reno_followup', '{}'::jsonb) AS reno_followup`,
    [args.clientId, args.path, JSON.stringify(args.data)]
  );

  if (result.rows.length === 0) {
    throw new Error(`Client with id ${args.clientId} not found.`);
  }

  return result.rows[0];
}

async function getClientMetaData(clientId: number) {
  const result = await query(
    `SELECT id AS client_id,
            COALESCE(meta_data, '{}'::jsonb) AS meta_data,
            COALESCE(meta_data->'reno_followup', '{}'::jsonb) AS reno_followup
       FROM clientes
      WHERE id = $1`,
    [clientId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Client with id ${clientId} not found.`);
  }

  return result.rows[0];
}

async function getRenoFollowupState(clientId: number) {
  const row = await getClientMetaData(clientId);
  return {
    client_id: row.client_id,
    ...getRenoFollowupStateFromMeta(row.meta_data),
  };
}

async function claimNextRenoFollowupCandidate(args: {
  brokerId: number;
  queueIntervalMinutes: number;
  preferFlow: RenoFlow;
}) {
  return withTransaction(async (client) => {
    const cooldown = await client.query(
      `SELECT a.created_at,
              a.created_at + ($2::int * INTERVAL '1 minute') AS next_available_at,
              (a.created_at + ($2::int * INTERVAL '1 minute')) > LOCALTIMESTAMP AS blocked
         FROM clientes_id_anotacoes a
         JOIN clientes c ON c.id = a.cliente_id
        WHERE c.broker_id = $1
          AND a.user_id = $1
          AND a.text LIKE 'Reno enviou follow-up de % via WhatsApp.%'
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [args.brokerId, args.queueIntervalMinutes]
    );

    if (cooldown.rows[0]?.blocked) {
      return {
        can_send: false,
        reason: `last_message_sent_less_than_${args.queueIntervalMinutes}_minutes_ago`,
        next_available_at: isoDateOrNull(cooldown.rows[0].next_available_at),
      };
    }

    const candidate = await client.query(
      `SELECT c.id, c.full_name, c.phone, c.status, c.meta_data,
              flow_data.flow,
              flow_data.state,
              COALESCE((flow_data.state->>'step')::int, 1) AS step,
              flow_data.state->>'last_context_bucket' AS last_context_bucket
         FROM clientes c
         CROSS JOIN LATERAL (
           VALUES
             ('repescagem'::text, c.meta_data #> '{reno_followup,repescagem}'),
             ('resgate'::text, c.meta_data #> '{reno_followup,resgate}')
         ) AS flow_data(flow, state)
        WHERE c.broker_id = $1
          AND flow_data.flow IN ('repescagem', 'resgate')
          AND flow_data.state IS NOT NULL
          AND COALESCE((flow_data.state->>'enabled')::boolean, true) = true
          AND NULLIF(flow_data.state->>'stopped_reason', '') IS NULL
          AND (flow_data.flow <> 'repescagem' OR c.status = 'Não Respondeu')
          AND (flow_data.flow <> 'resgate' OR c.status = 'Em Atendimento')
          AND COALESCE(NULLIF(flow_data.state->>'next_run_at', '')::timestamptz, '-infinity'::timestamptz) <= NOW()
          AND (
            NULLIF(flow_data.state->>'claim_expires_at', '') IS NULL
            OR (flow_data.state->>'claim_expires_at')::timestamptz <= NOW()
          )
        ORDER BY CASE WHEN flow_data.flow = $2 THEN 0 ELSE 1 END,
                 COALESCE(NULLIF(flow_data.state->>'next_run_at', '')::timestamptz, '-infinity'::timestamptz),
                 c.id
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED`,
      [args.brokerId, args.preferFlow]
    );

    if (candidate.rows.length === 0) {
      const nextDue = await client.query(
        `SELECT MIN(NULLIF(flow_data.state->>'next_run_at', '')::timestamptz) AS next_available_at
           FROM clientes c
           CROSS JOIN LATERAL (
             VALUES
               ('repescagem'::text, c.meta_data #> '{reno_followup,repescagem}'),
               ('resgate'::text, c.meta_data #> '{reno_followup,resgate}')
           ) AS flow_data(flow, state)
          WHERE c.broker_id = $1
            AND flow_data.state IS NOT NULL
            AND COALESCE((flow_data.state->>'enabled')::boolean, true) = true
            AND NULLIF(flow_data.state->>'stopped_reason', '') IS NULL
            AND (flow_data.flow <> 'repescagem' OR c.status = 'Não Respondeu')
            AND (flow_data.flow <> 'resgate' OR c.status = 'Em Atendimento')`,
        [args.brokerId]
      );

      return {
        can_send: false,
        reason: 'no_due_candidate',
        next_available_at: isoDateOrNull(nextDue.rows[0]?.next_available_at),
      };
    }

    const row = candidate.rows[0];
    const flow = normalizeFlow(row.flow);
    const claimToken = crypto.randomUUID();
    const path = ['reno_followup', flow];

    await client.query(
      `UPDATE clientes
          SET meta_data = jsonb_set(
                COALESCE(meta_data, '{}'::jsonb),
                $2::text[],
                COALESCE(meta_data #> $2::text[], '{}'::jsonb)
                  || jsonb_build_object(
                       'claimed_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '-03:00',
                       'claim_expires_at', to_char(NOW() + ($3::int * INTERVAL '1 minute'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '-03:00',
                       'claim_token', $4::text
                     ),
                true
              ),
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, path, DEFAULT_CLAIM_TTL_MINUTES, claimToken]
    );

    const step = Number(row.step) || 1;
    const message = buildRenoFollowupMessage({
      flow,
      fullName: row.full_name,
      step,
      lastContextBucket: row.last_context_bucket,
    });

    return {
      can_send: true,
      flow,
      client: {
        id: row.id,
        full_name: row.full_name,
        phone: row.phone,
        status: row.status,
      },
      step,
      message,
    };
  });
}

async function markRenoFollowupSent(args: {
  clientId: number;
  flow: RenoFlow;
  step: number;
  message: string;
  sentAt: string;
  nextRunAt: string;
  userId: number;
  lastContextBucket?: string | null;
}) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT meta_data #> $2::text[] AS state
         FROM clientes
        WHERE id = $1
        FOR UPDATE`,
      [args.clientId, ['reno_followup', args.flow]]
    );

    if (existing.rows.length === 0) {
      throw new Error(`Client with id ${args.clientId} not found.`);
    }

    const previousState = asJsonObject(existing.rows[0].state);
    const lastContextBucket =
      args.lastContextBucket ?? (typeof previousState.last_context_bucket === 'string' ? previousState.last_context_bucket : null);
    const state: JsonObject = {
      ...previousState,
      enabled: true,
      step: args.step,
      last_sent_at: args.sentAt,
      next_run_at: args.nextRunAt,
      stopped_reason: null,
      last_message: args.message,
      claimed_at: null,
      claim_expires_at: null,
      claim_token: null,
    };

    if (args.flow === 'resgate' && lastContextBucket) {
      state.last_context_bucket = lastContextBucket;
    }

    const updated = await client.query(
      `UPDATE clientes
          SET meta_data = jsonb_set(COALESCE(meta_data, '{}'::jsonb), $2::text[], $3::jsonb, true),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id AS client_id, meta_data #> $2::text[] AS state`,
      [args.clientId, ['reno_followup', args.flow], JSON.stringify(state)]
    );

    const noteText = buildRenoSentNoteText({
      flow: args.flow,
      step: args.step,
      message: args.message,
      nextRunAt: args.nextRunAt,
      lastContextBucket,
    });

    const note = await client.query(
      `INSERT INTO clientes_id_anotacoes (cliente_id, user_id, text, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, cliente_id, user_id, text, created_at`,
      [args.clientId, args.userId, noteText]
    );

    return {
      success: true,
      client_id: args.clientId,
      flow: args.flow,
      state: updated.rows[0].state,
      note: note.rows[0],
    };
  });
}

async function markRenoFollowupFailed(args: {
  clientId: number;
  flow: RenoFlow;
  errorSummary: string;
  stoppedReason: string;
  userId: number;
}) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT meta_data #> $2::text[] AS state
         FROM clientes
        WHERE id = $1
        FOR UPDATE`,
      [args.clientId, ['reno_followup', args.flow]]
    );

    if (existing.rows.length === 0) {
      throw new Error(`Client with id ${args.clientId} not found.`);
    }

    const state: JsonObject = {
      ...asJsonObject(existing.rows[0].state),
      enabled: false,
      stopped_reason: args.stoppedReason,
      failed_at: new Date().toISOString(),
      error_summary: args.errorSummary,
      claimed_at: null,
      claim_expires_at: null,
      claim_token: null,
    };

    const updated = await client.query(
      `UPDATE clientes
          SET meta_data = jsonb_set(COALESCE(meta_data, '{}'::jsonb), $2::text[], $3::jsonb, true),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id AS client_id, meta_data #> $2::text[] AS state`,
      [args.clientId, ['reno_followup', args.flow], JSON.stringify(state)]
    );

    const note = await client.query(
      `INSERT INTO clientes_id_anotacoes (cliente_id, user_id, text, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, cliente_id, user_id, text, created_at`,
      [
        args.clientId,
        args.userId,
        buildRenoFailedNoteText({
          flow: args.flow,
          errorSummary: args.errorSummary,
          stoppedReason: args.stoppedReason,
        }),
      ]
    );

    return {
      success: true,
      client_id: args.clientId,
      flow: args.flow,
      state: updated.rows[0].state,
      note: note.rows[0],
    };
  });
}

export function registerRenoFollowupTools(server: McpServer) {
  server.registerTool(
    'get_client_meta_data',
    {
      title: 'Get Client Meta Data',
      description: 'Get the meta_data JSONB for a client, including the reno_followup branch.',
      inputSchema: {
        client_id: z.number().int().positive().describe('Client ID'),
      },
    },
    async ({ client_id }) => {
      try {
        return jsonResponse(await getClientMetaData(client_id));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Error fetching client meta_data: ${msg}`);
      }
    }
  );

  server.registerTool(
    'update_client_meta_data_branch',
    {
      title: 'Update Client Meta Data Branch',
      description: 'Safely update one meta_data JSONB branch for a client while preserving the rest.',
      inputSchema: {
        client_id: z.number().int().positive().describe('Client ID'),
        path: z.array(z.string()).min(1).max(8).describe('JSON path inside meta_data, e.g. ["reno_followup", "repescagem"]'),
        data: z.record(z.unknown()).describe('Object to store at the JSON path'),
      },
    },
    async ({ client_id, path, data }) => {
      try {
        return jsonResponse(await updateClientMetaDataBranch({ clientId: client_id, path, data }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Error updating client meta_data branch: ${msg}`);
      }
    }
  );

  server.registerTool(
    'get_reno_followup_state',
    {
      title: 'Get Reno Followup State',
      description: 'Read the Reno follow-up state for repescagem and resgate from client meta_data.',
      inputSchema: {
        client_id: z.number().int().positive().describe('Client ID'),
      },
    },
    async ({ client_id }) => {
      try {
        return jsonResponse(await getRenoFollowupState(client_id));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Error fetching Reno follow-up state: ${msg}`);
      }
    }
  );

  server.registerTool(
    'update_reno_followup_state',
    {
      title: 'Update Reno Followup State',
      description: 'Update the Reno follow-up branch for repescagem or resgate without manual SQL.',
      inputSchema: {
        client_id: z.number().int().positive().describe('Client ID'),
        flow: z.enum(RENO_FLOWS).describe('Reno flow to update'),
        step: z.number().int().min(0).describe('Current follow-up step'),
        last_sent_at: z.string().optional().nullable().describe('Last send timestamp (ISO 8601)'),
        next_run_at: z.string().optional().nullable().describe('Next run timestamp (ISO 8601)'),
        stopped_reason: z.string().optional().nullable().describe('Reason the flow stopped, or null to keep active'),
        enabled: z.boolean().optional().default(true).describe('Whether this follow-up branch is enabled'),
        last_context_bucket: z.string().optional().nullable().describe('Resgate context bucket'),
      },
    },
    async ({ client_id, flow, step, last_sent_at, next_run_at, stopped_reason, enabled, last_context_bucket }) => {
      try {
        const state: JsonObject = {
          enabled,
          step,
          last_sent_at: last_sent_at ?? null,
          next_run_at: next_run_at ?? null,
          stopped_reason: stopped_reason ?? null,
        };

        if (flow === 'resgate' && last_context_bucket !== undefined) {
          state.last_context_bucket = last_context_bucket;
        }

        const updated = await updateClientMetaDataBranch({
          clientId: client_id,
          path: ['reno_followup', flow],
          data: state,
        });

        return jsonResponse({
          client_id,
          flow,
          state: updated.meta_data?.reno_followup?.[flow] ?? state,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Error updating Reno follow-up state: ${msg}`);
      }
    }
  );

  server.registerTool(
    'claim_next_reno_followup_candidate',
    {
      title: 'Claim Next Reno Followup Candidate',
      description: 'Select and claim the next eligible Reno follow-up candidate using row locks and queue cooldown.',
      inputSchema: {
        broker_id: z.number().int().positive().describe('Broker/user ID'),
        queue_interval_minutes: z.number().int().positive().optional().default(3).describe('Minimum minutes between sends for this broker'),
        prefer_flow: z.enum(RENO_FLOWS).optional().default('repescagem').describe('Preferred flow when multiple candidates are due'),
      },
    },
    async ({ broker_id, queue_interval_minutes, prefer_flow }) => {
      try {
        return jsonResponse(
          await claimNextRenoFollowupCandidate({
            brokerId: broker_id,
            queueIntervalMinutes: queue_interval_minutes,
            preferFlow: prefer_flow,
          })
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Error claiming Reno follow-up candidate: ${msg}`);
      }
    }
  );

  server.registerTool(
    'mark_reno_followup_sent',
    {
      title: 'Mark Reno Followup Sent',
      description: 'Record a successful Reno WhatsApp follow-up send in meta_data and CRM notes while preserving client status.',
      inputSchema: {
        client_id: z.number().int().positive().describe('Client ID'),
        flow: z.enum(RENO_FLOWS).describe('Reno flow'),
        step: z.number().int().min(0).describe('Sent step'),
        message: z.string().min(1).describe('Message sent by WhatsApp'),
        sent_at: z.string().describe('Send timestamp (ISO 8601)'),
        next_run_at: z.string().describe('Next run timestamp (ISO 8601)'),
        user_id: z.number().int().positive().describe('CRM user ID that owns the note'),
        last_context_bucket: z.string().optional().nullable().describe('Resgate context bucket'),
        bucket: z.string().optional().nullable().describe('Alias for last_context_bucket'),
      },
    },
    async ({ client_id, flow, step, message, sent_at, next_run_at, user_id, last_context_bucket, bucket }) => {
      try {
        return jsonResponse(
          await markRenoFollowupSent({
            clientId: client_id,
            flow,
            step,
            message,
            sentAt: sent_at,
            nextRunAt: next_run_at,
            userId: user_id,
            lastContextBucket: last_context_bucket ?? bucket ?? null,
          })
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Error marking Reno follow-up as sent: ${msg}`);
      }
    }
  );

  server.registerTool(
    'mark_reno_followup_failed',
    {
      title: 'Mark Reno Followup Failed',
      description: 'Record a terminal Reno WhatsApp follow-up failure in meta_data and CRM notes while preserving client status.',
      inputSchema: {
        client_id: z.number().int().positive().describe('Client ID'),
        flow: z.enum(RENO_FLOWS).describe('Reno flow'),
        error_summary: z.string().min(1).describe('Short failure summary'),
        stopped_reason: z.string().min(1).describe('Terminal stopped reason'),
        user_id: z.number().int().positive().describe('CRM user ID that owns the note'),
      },
    },
    async ({ client_id, flow, error_summary, stopped_reason, user_id }) => {
      try {
        return jsonResponse(
          await markRenoFollowupFailed({
            clientId: client_id,
            flow,
            errorSummary: error_summary,
            stoppedReason: stopped_reason,
            userId: user_id,
          })
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Error marking Reno follow-up as failed: ${msg}`);
      }
    }
  );
}
