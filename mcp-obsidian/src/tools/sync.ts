import { z } from 'zod';
import { ToolCtx, tryToolBody, ok } from './_shared.js';
import { McpError, McpToolResponse } from '../errors.js';

export const CommitAndPushSchema = z.object({ message: z.string().min(1) });

export async function commitAndPush(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = CommitAndPushSchema.parse(args);
    if (!ctx.git) throw new McpError('VAULT_IO_ERROR', 'git ops not configured');
    return await ctx.git.commitAndPush(a.message);
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `sha=${(r.value as any).sha || 'no-op'} pushed=${(r.value as any).pushed}`);
}

export const GitStatusSchema = z.object({}).passthrough();

export async function gitStatus(_args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    if (!ctx.git) throw new McpError('VAULT_IO_ERROR', 'git ops not configured');
    return await ctx.git.status();
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `modified=${sc.modified.length} untracked=${sc.untracked.length} ahead=${sc.ahead} behind=${sc.behind}`);
}
