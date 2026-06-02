import type { McpToolResponse } from '../errors.js';
import type { SemanticSearchFilter } from '../vault/semantic/types.js';
import type { ToolCtx } from './_shared.js';

type ToolAnnotations = Record<string, boolean | undefined>;

export const SEMANTIC_AUGMENT_TIMEOUT_MS = 750;
export const SEMANTIC_SIDE_EFFECT_TIMEOUT_MS = 750;

const EXPLICIT_SEMANTIC_TOOLS = new Set(['semantic_search', 'rebuild_semantic_index']);
const DELETE_TOOLS = new Set(['delete_note', 'delete_path']);
const WRITE_TOOLS = new Set([
  'write_note',
  'append_to_note',
  'create_journal_event',
  'create_journal_entry',
  'record_decision',
  'append_decision',
  'update_agent_profile',
  'upsert_goal',
  'upsert_result',
  'upsert_financial_snapshot',
  'upsert_shared_context',
  'create_or_update_entity',
  'upsert_entity_profile',
  'update_hub',
  'upsert_hub',
  'upsert_runbook',
  'upsert_lead_timeline',
  'append_lead_interaction',
  'upsert_broker_profile',
  'append_broker_interaction',
  'bootstrap_agent',
]);

export async function applySemanticSideEffects(
  toolName: string,
  args: unknown,
  response: McpToolResponse,
  ctx: ToolCtx,
): Promise<void> {
  if (EXPLICIT_SEMANTIC_TOOLS.has(toolName)) return;
  if (!ctx.semantic || response.isError) return;

  try {
    const structuredContent = recordOrEmpty(response.structuredContent);
    const paths = extractRelevantPaths(args, structuredContent);
    if (paths.length === 0) return;

    if (DELETE_TOOLS.has(toolName)) {
      await withTimeout(
        Promise.all(paths.map((rel) => ctx.semantic!.deletePath(rel))).then(() => undefined),
        SEMANTIC_SIDE_EFFECT_TIMEOUT_MS,
      );
      return;
    }

    if (WRITE_TOOLS.has(toolName)) {
      const markdownPaths = paths.filter(isExactMarkdownPath);
      if (markdownPaths.length === 0) return;
      await withTimeout(
        Promise.all(markdownPaths.map((rel) => ctx.semantic!.indexPath(rel))).then(() => undefined),
        SEMANTIC_SIDE_EFFECT_TIMEOUT_MS,
      );
    }
  } catch {
    return;
  }
}

export async function augmentSemanticResponse(
  toolName: string,
  args: unknown,
  response: McpToolResponse,
  ctx: ToolCtx,
  annotations: ToolAnnotations,
): Promise<McpToolResponse> {
  if (EXPLICIT_SEMANTIC_TOOLS.has(toolName)) return response;
  if (!ctx.semantic || response.isError) return response;

  try {
    const structuredContent = response.structuredContent ?? {};
    const query = buildSemanticQuery(toolName, args, structuredContent);
    if (query.length === 0) return response;

    const filter = extractSemanticFilter(args, structuredContent, annotations);
    const matches = await withTimeout(
      ctx.semantic.search({ query, limit: 5, filter }),
      SEMANTIC_AUGMENT_TIMEOUT_MS,
    );
    if (matches.length === 0) return response;

    const resultKey = annotations.readOnlyHint ? 'semantic_memory' : 'semantic_warnings';
    return {
      ...response,
      structuredContent: {
        ...structuredContent,
        [resultKey]: matches,
      },
    };
  } catch {
    return response;
  }
}

function buildSemanticQuery(
  toolName: string,
  args: unknown,
  structuredContent: Record<string, unknown>,
): string {
  const argRecord = recordOrEmpty(args);
  const parts: string[] = [];

  addString(parts, argRecord.query);
  addString(parts, argRecord.title);
  addString(parts, argRecord.content);
  addString(parts, structuredContent.content);
  addString(parts, structuredContent.path);

  const metadataKeys = ['owner', 'type', 'tag', 'tags', 'heading', 'status', 'as_agent'];
  for (const key of metadataKeys) {
    addSmallValue(parts, argRecord[key]);
    addSmallValue(parts, structuredContent[key]);
  }
  addString(parts, toolName);

  return parts.join('\n').trim();
}

function extractSemanticFilter(
  args: unknown,
  structuredContent: Record<string, unknown>,
  annotations: ToolAnnotations,
): SemanticSearchFilter | undefined {
  const argRecord = recordOrEmpty(args);
  const filter: SemanticSearchFilter = {};
  const responsePath = stringValue(structuredContent.path);
  const argPath = stringValue(argRecord.path);

  if (annotations.readOnlyHint) {
    const excludePath = responsePath ?? argPath;
    if (excludePath !== undefined && isExactMarkdownPath(excludePath)) {
      filter.excludePath = excludePath;
    }
  }

  if (argPath !== undefined && isExactMarkdownPath(argPath) && argPath !== filter.excludePath) {
    filter.path = argPath;
  } else {
    const contentPath = stringValue(structuredContent.filter_path) ?? stringValue(structuredContent.search_path);
    if (contentPath !== undefined && isExactMarkdownPath(contentPath) && contentPath !== filter.excludePath) {
      filter.path = contentPath;
    }
  }

  const owner = stringOrStringArray(argRecord.owner) ?? stringOrStringArray(structuredContent.owner);
  if (owner !== undefined) filter.owner = owner;

  const type = stringValue(argRecord.type) ?? stringValue(structuredContent.type);
  if (type !== undefined) filter.type = type;

  const tag = stringValue(argRecord.tag) ?? stringValue(structuredContent.tag) ?? firstString(structuredContent.tags);
  if (tag !== undefined) filter.tag = tag;

  return Object.keys(filter).length > 0 ? filter : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function addString(parts: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length > 0) parts.push(trimmed.slice(0, 2000));
}

function addSmallValue(parts: string[], value: unknown): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed.length <= 120) parts.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string').slice(0, 8);
    if (strings.length > 0) parts.push(strings.join(' '));
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is string => typeof item === 'string' && item.trim().length > 0)?.trim();
}

function stringOrStringArray(value: unknown): string | string[] | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings.map((item) => item.trim()) : undefined;
}

function extractRelevantPaths(args: unknown, structuredContent: Record<string, unknown>): string[] {
  const argRecord = recordOrEmpty(args);
  const paths = new Set<string>();

  addPath(paths, argRecord.path);
  addPath(paths, structuredContent.path);
  addPath(paths, structuredContent.new_path);
  addPathArray(paths, argRecord.paths);
  addPathArray(paths, structuredContent.paths);
  addPathArray(paths, structuredContent.files_created);

  return [...paths];
}

function addPath(paths: Set<string>, value: unknown): void {
  const path = stringValue(value);
  if (path !== undefined) paths.add(path.replace(/\\/g, '/'));
}

function addPathArray(paths: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    addPath(paths, item);
  }
}

function isExactMarkdownPath(rel: string): boolean {
  return rel.trim().replace(/\\/g, '/').toLowerCase().endsWith('.md');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('semantic augment timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
