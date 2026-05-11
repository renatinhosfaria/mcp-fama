// src/vault/frontmatter.ts
import matter from 'gray-matter';
import { z } from 'zod';
import { McpError } from '../errors.js';
import { normalizeDateInput, validateV1Frontmatter } from './schema-v1.js';

export const FRONTMATTER_TYPES = [
  'moc','context','agents-map','goal','goals-index',
  'result','results-index','agent-readme','agent-profile',
  'agent-decisions','journal','project-readme',
  'shared-context','entity-profile','financial-snapshot',
  'entity','decision','concept','reference','runbook',
  'hub','interaction','project',
] as const;

const periodRe = /^\d{4}-\d{2}$/;
const kebabSegment = /^[a-z0-9][a-z0-9-]*$/;
const yamlDateScalarRe = /^\d{4}-\d{2}-\d{2}(?:[tT]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[zZ]|[+-]\d{2}:\d{2}))?$/;

// gray-matter parses unquoted YAML dates (2026-04-01) as JS Date objects.
// We coerce them to YYYY-MM-DD strings before validating.
function dateToIso(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return val as string;
}

const DateField = z.preprocess(dateToIso, z.string().refine(v => {
  try { normalizeDateInput(v); return true; } catch { return false; }
}, 'must be YYYY-MM-DD or ISO-8601 with timezone'));

const BaseSchema = z.object({
  type: z.enum(FRONTMATTER_TYPES),
  owner: z.string().min(1),
  created: DateField,
  updated: DateField,
  tags: z.array(z.string()).default([]),
}).passthrough();

const JournalSchema = BaseSchema.extend({
  type: z.literal('journal'),
  title: z.string().optional(),
});

const GoalResultSchema = BaseSchema.extend({
  type: z.union([z.literal('goal'), z.literal('result')]),
  period: z.string().regex(periodRe, 'period must be YYYY-MM'),
});

const SharedContextSchema = BaseSchema.extend({
  type: z.literal('shared-context'),
  topic: z.string().regex(kebabSegment),
  title: z.string().min(1),
});

const EntityProfileSchema = BaseSchema.extend({
  type: z.literal('entity-profile'),
  entity_type: z.string().regex(kebabSegment),
  entity_name: z.string().min(1),
  status: z.string().optional(),
  // Lead-specific (Plan 2)
  status_comercial: z.string().optional(),
  origem: z.string().optional(),
  interesse_atual: z.string().optional(),
  objecoes_ativas: z.array(z.string()).optional(),
  proximo_passo: z.string().optional(),
  // Broker-specific (Plan 3)
  equipe: z.string().optional(),
  nivel_engajamento: z.string().optional(),
  comunicacao_estilo: z.string().optional(),
  contato_email: z.string().optional(),
  contato_whatsapp: z.string().optional(),
  dificuldades_recorrentes: z.array(z.string()).optional(),
  padroes_atendimento: z.string().optional(),
  pendencias_abertas: z.array(z.string()).optional(),
  // Broker-exec (Plan 7)
  nivel_atencao: z.string().optional(),
  ultima_acao_recomendada: z.string().refine(s => !s.includes('\n'), 'ultima_acao_recomendada must be one line').optional(),
}).passthrough();

const FinancialSnapshotSchema = BaseSchema.extend({
  type: z.literal('financial-snapshot'),
  period: z.string().regex(periodRe, 'period must be YYYY-MM'),
  caixa_resumo: z.string().refine(s => !s.includes('\n'), 'caixa_resumo must be one line').optional(),
  receita_resumo: z.string().refine(s => !s.includes('\n'), 'receita_resumo must be one line').optional(),
  despesa_resumo: z.string().refine(s => !s.includes('\n'), 'despesa_resumo must be one line').optional(),
  alertas_count: z.number().int().nonnegative().optional(),
});

const InteractionSchema = BaseSchema.extend({
  type: z.literal('interaction'),
  channel: z.string().min(1),
  participants: z.array(z.string()).min(1),
});

const DecisionSchema = BaseSchema.extend({
  type: z.literal('decision'),
  decided_by: z.string().min(1),
  supersedes: z.string().optional(),
  superseded_by: z.string().optional(),
});

const EntitySchema = BaseSchema.extend({
  type: z.literal('entity'),
  subtype: z.enum(['person','org','property','project']),
  aliases: z.array(z.string()).optional(),
  relationships: z.array(z.any()).optional(),
  external_ids: z.record(z.string()).optional(),
});

const HubSchema = BaseSchema.extend({
  type: z.literal('hub'),
  scope: z.string().min(1),
  maintainer: z.string().min(1),
});

const ConceptSchema = BaseSchema.extend({
  type: z.literal('concept'),
  derives_from: z.string().optional(),
});

const ReferenceSchema = BaseSchema.extend({
  type: z.literal('reference'),
  source_url: z.string().url(),
  source_author: z.string().optional(),
  source_date: DateField.optional(),
});

const RunbookSchema = BaseSchema.extend({
  type: z.literal('runbook'),
  procedure_owner: z.string().min(1),
  trigger: z.string().min(1),
});

const ProjectV1Schema = BaseSchema.extend({
  type: z.literal('project'),
  goal: z.string().min(1),
  status_lifecycle: z.enum(['active','archived']),
  owner: z.string().min(1),
});

const V1_INTERACTION_SCHEMA = z.object({
  type: z.literal('interaction'),
  channel: z.string().min(1),
  participants: z.array(z.string()).min(1),
}).passthrough();

const DecisionLinkField = z.union([z.string().min(1), z.array(z.string())]);

const V1_DECISION_SCHEMA = z.object({
  type: z.literal('decision'),
  decided_by: DecisionLinkField,
  supersedes: DecisionLinkField.optional(),
  superseded_by: DecisionLinkField.optional(),
  mentions_entity: z.array(z.string()).optional(),
  implements: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
}).passthrough();

const V1_ENTITY_SCHEMA = z.object({
  type: z.literal('entity'),
  subtype: z.enum(['person','org','property','project']).optional(),
  name: z.string().min(1).optional(),
  entity_type: z.string().regex(kebabSegment).optional(),
  aliases: z.array(z.string()).optional(),
  relationships: z.array(z.any()).optional(),
  external_ids: z.record(z.string()).optional(),
  mentions_entity: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  verified_by: z.union([z.string(), z.null()]).optional(),
  verified_at: z.string().optional(),
  superseded_by: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough().superRefine((fm, ctx) => {
  if (!fm.subtype && !fm.entity_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entity_type'],
      message: 'entity_type or subtype is required',
    });
  }
});

const V1_HUB_SCHEMA = z.object({
  type: z.literal('hub'),
  scope: z.string().min(1),
  maintainer: z.string().min(1),
}).passthrough();

const V1_CONCEPT_SCHEMA = z.object({
  type: z.literal('concept'),
  derives_from: z.string().optional(),
}).passthrough();

const V1_REFERENCE_SCHEMA = z.object({
  type: z.literal('reference'),
  source_url: z.string().url(),
  source_author: z.string().optional(),
  source_date: DateField.optional(),
}).passthrough();

const V1_RUNBOOK_SCHEMA = z.object({
  type: z.literal('runbook'),
  procedure_owner: z.string().min(1),
  trigger: z.string().min(1),
}).passthrough();

const V1_PROJECT_SCHEMA = z.object({
  type: z.literal('project'),
  goal: z.string().min(1),
  status_lifecycle: z.enum(['active','archived']),
}).passthrough();

const TYPE_TO_SCHEMA: Record<string, z.ZodTypeAny> = {
  journal: JournalSchema,
  goal: GoalResultSchema,
  result: GoalResultSchema,
  'shared-context': SharedContextSchema,
  'entity-profile': EntityProfileSchema,
  'financial-snapshot': FinancialSnapshotSchema,
  entity: EntitySchema,
  decision: DecisionSchema,
  concept: ConceptSchema,
  reference: ReferenceSchema,
  runbook: RunbookSchema,
  hub: HubSchema,
  interaction: InteractionSchema,
  project: ProjectV1Schema,
};

const V1_TYPE_TO_SCHEMA: Record<string, z.ZodTypeAny> = {
  entity: V1_ENTITY_SCHEMA,
  decision: V1_DECISION_SCHEMA,
  concept: V1_CONCEPT_SCHEMA,
  reference: V1_REFERENCE_SCHEMA,
  runbook: V1_RUNBOOK_SCHEMA,
  hub: V1_HUB_SCHEMA,
  interaction: V1_INTERACTION_SCHEMA,
  project: V1_PROJECT_SCHEMA,
};

function rawFrontmatterBlock(src: string, parsedMatter: unknown): string {
  if (typeof parsedMatter === 'string') return parsedMatter;
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? '';
}

function topLevelYamlDateScalars(rawMatter: string): Record<string, string> {
  const dates: Record<string, string> = {};
  for (const line of rawMatter.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith(' ') || line.startsWith('\t') || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/\s+#.*$/, '').trim();
    if (yamlDateScalarRe.test(value)) {
      dates[match[1]] = value;
    }
  }
  return dates;
}

function restoreYamlDateScalars(data: Record<string, any>, rawMatter: string): Record<string, any> {
  const dates = topLevelYamlDateScalars(rawMatter);
  const restored = { ...data };
  for (const [key, value] of Object.entries(dates)) {
    if (data[key] instanceof Date) {
      restored[key] = value;
    }
  }
  return restored;
}

export interface ParseResult {
  frontmatter: Record<string, any> | null;
  body: string;
}

export function parseFrontmatter(src: string): ParseResult {
  const parsed = matter(src);
  // gray-matter caches parsed results; on cache hits `parsed.matter` may be undefined
  // even when the file has frontmatter. Use `matter.test()` which is cache-safe.
  if (!matter.test(src)) {
    return { frontmatter: null, body: src };
  }
  const data = restoreYamlDateScalars(parsed.data as any, rawFrontmatterBlock(src, parsed.matter));
  if (data?.schema_version === 1) {
    const v1Frontmatter = validateV1Frontmatter(data);
    const schema = V1_TYPE_TO_SCHEMA[v1Frontmatter.type];
    if (schema) {
      const result = schema.safeParse(v1Frontmatter);
      if (!result.success) {
        throw new McpError('INVALID_FRONTMATTER', `Frontmatter invalid: ${result.error.errors.map(e => `${e.path.join('.')}:${e.message}`).join('; ')}`);
      }
      return { frontmatter: result.data as Record<string, any>, body: parsed.content };
    }
    return { frontmatter: v1Frontmatter, body: parsed.content };
  }
  const schema = TYPE_TO_SCHEMA[data?.type] ?? BaseSchema;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new McpError('INVALID_FRONTMATTER', `Frontmatter invalid: ${result.error.errors.map(e => `${e.path.join('.')}:${e.message}`).join('; ')}`);
  }
  return { frontmatter: result.data as Record<string, any>, body: parsed.content };
}

export function serializeFrontmatter(frontmatter: Record<string, any>, body: string): string {
  return matter.stringify(body, frontmatter);
}
