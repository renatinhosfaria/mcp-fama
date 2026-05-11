import { z } from 'zod';
import { McpError } from '../errors.js';

export const V1_TYPES = ['interaction','decision','entity','hub','journal','concept','reference','runbook','project','goal','result'] as const;
export const V1_STATUSES = ['draft','active','superseded','archived'] as const;
export const V1_SOURCES = ['human-curated','agent-generated','imported'] as const;

const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;

function coerceYamlDate(input: unknown): unknown {
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  return input;
}

export function normalizeDateInput(input: string): { date: string; timestamp?: string } {
  if (dateOnlyRe.test(input)) return { date: input };
  const ms = Date.parse(input);
  if (Number.isNaN(ms) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(input)) {
    throw new McpError('INVALID_SCHEMA_V1', `Date must be YYYY-MM-DD or ISO-8601 with timezone: ${input}`);
  }
  return { date: input.slice(0, 10), timestamp: input };
}

const V1DateField = z.preprocess(coerceYamlDate, z.string().refine(v => {
  try { normalizeDateInput(v); return true; } catch { return false; }
}, 'must be YYYY-MM-DD or ISO-8601 with timezone'));

export const V1CommonSchema = z.object({
  schema_version: z.literal(1),
  type: z.enum(V1_TYPES),
  status: z.enum(V1_STATUSES),
  created: V1DateField,
  updated: V1DateField,
  source: z.enum(V1_SOURCES),
  tags: z.array(z.string()),
}).passthrough();

export function validateV1Frontmatter(fm: Record<string, any>): Record<string, any> {
  const result = V1CommonSchema.safeParse(fm);
  if (!result.success) {
    throw new McpError('INVALID_SCHEMA_V1', `Schema v1 invalid: ${result.error.errors.map(e => `${e.path.join('.')}:${e.message}`).join('; ')}`);
  }
  return result.data;
}

export function buildV1Frontmatter(input: Record<string, any>, today: string): Record<string, any> {
  return validateV1Frontmatter({
    schema_version: 1,
    status: input.status ?? 'active',
    created: input.created ?? today,
    updated: today,
    source: input.source ?? 'agent-generated',
    tags: input.tags ?? [],
    ...input,
  });
}
