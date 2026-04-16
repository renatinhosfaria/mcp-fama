// src/vault/frontmatter.ts
import matter from 'gray-matter';
import { z } from 'zod';
import { McpError } from '../errors.js';

export const FRONTMATTER_TYPES = [
  'moc','context','agents-map','goal','goals-index',
  'result','results-index','agent-readme','agent-profile',
  'agent-decisions','journal','project-readme',
  'shared-context','entity-profile',
] as const;

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const periodRe = /^\d{4}-\d{2}$/;
const kebabSegment = /^[a-z0-9][a-z0-9-]*$/;

// gray-matter parses unquoted YAML dates (2026-04-01) as JS Date objects.
// We coerce them to YYYY-MM-DD strings before validating.
function dateToIso(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return val as string;
}

const DateField = z.preprocess(dateToIso, z.string().regex(dateRe, 'must be YYYY-MM-DD'));

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
  // Lead-specific fields (optional; validated when present)
  status_comercial: z.string().optional(),
  origem: z.string().optional(),
  interesse_atual: z.string().optional(),
  objecoes_ativas: z.array(z.string()).optional(),
  proximo_passo: z.string().optional(),
}).passthrough();

const TYPE_TO_SCHEMA: Record<string, z.ZodTypeAny> = {
  journal: JournalSchema,
  goal: GoalResultSchema,
  result: GoalResultSchema,
  'shared-context': SharedContextSchema,
  'entity-profile': EntityProfileSchema,
};

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
  const data = parsed.data as any;
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
