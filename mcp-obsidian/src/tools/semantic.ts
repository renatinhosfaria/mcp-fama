import { z } from 'zod';
import { McpToolResponse } from '../errors.js';
import { ToolCtx, ok, tryToolBody } from './_shared.js';

export const SemanticSearchSchema = z.object({
  query: z.string().min(1),
  path: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  owner: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  min_score: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().max(20).optional().default(5),
}).passthrough();

export const RebuildSemanticIndexSchema = z.object({
  as_agent: z.string().min(1),
  path: z.string().min(1).optional(),
  force: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(5000).optional(),
}).passthrough();

export async function semanticSearch(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const { query, path, type, tag, owner, min_score: minScore, limit } = SemanticSearchSchema.parse(args);
    if (!ctx.semantic) return semanticDisabled();

    const matches = await ctx.semantic.search({
      query,
      minScore,
      limit,
      filter: { path, type, tag, owner },
    });

    return ok({ matches }, `${matches.length} semantic match(es)`);
  });
  if (!r.ok) return r.err.toMcpResponse();
  return r.value;
}

export async function rebuildSemanticIndex(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const { as_agent: asAgent, path, force, limit } = RebuildSemanticIndexSchema.parse(args);
    if (!ctx.semantic) return semanticDisabled();

    const result = await ctx.semantic.rebuild({ asAgent, path, force, limit });
    return ok({ ...result }, `indexed=${result.indexed} skipped=${result.skipped} deleted=${result.deleted} errors=${result.errors.length}`);
  });
  if (!r.ok) return r.err.toMcpResponse();
  return r.value;
}

function semanticDisabled(): McpToolResponse {
  return {
    isError: true,
    content: [{ type: 'text', text: '[SEMANTIC_DISABLED] Semantic memory service is not configured' }],
    structuredContent: { error: { code: 'SEMANTIC_DISABLED', message: 'Semantic memory service is not configured' } },
  };
}
