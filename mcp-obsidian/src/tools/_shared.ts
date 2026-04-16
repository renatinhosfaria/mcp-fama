// src/tools/_shared.ts
import { McpError, McpToolResponse } from '../errors.js';
import { VaultIndex } from '../vault/index.js';
import type { GitOps } from '../vault/git.js';

export interface ToolCtx { index: VaultIndex; vaultRoot: string; git?: GitOps; }

export async function tryToolBody<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: McpError }> {
  try { return { ok: true, value: await fn() }; }
  catch (e: any) {
    if (e instanceof McpError) return { ok: false, err: e };
    return { ok: false, err: new McpError('VAULT_IO_ERROR', e.message ?? String(e)) };
  }
}

export function ok(structured: Record<string, unknown>, text: string): McpToolResponse {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export async function ownerCheck(ctx: ToolCtx, rel: string, asAgent: string): Promise<void> {
  const owner = await ctx.index.getOwnershipResolver().resolve(rel);
  if (owner === null) {
    throw new McpError('UNMAPPED_PATH', `Path '${rel}' não está mapeado em _shared/context/AGENTS.md. Adicione um pattern antes de escrever aqui.`);
  }
  if (owner !== asAgent) {
    throw new McpError('OWNERSHIP_VIOLATION', `File '${rel}' is owned by '${owner}', not '${asAgent}'. Use as_agent='${owner}' or write under your own agent path.`, `Use as_agent='${owner}'`);
  }
}

export function isDecisionsPath(rel: string): boolean { return /(^|\/)decisions\.md$/.test(rel); }

export async function validateOwners(ctx: ToolCtx, owner?: string | string[]): Promise<string[] | undefined> {
  if (!owner) return undefined;
  const list = Array.isArray(owner) ? owner : [owner];
  const valid = new Set(await ctx.index.getOwnershipResolver().listAgents());
  const bad = list.filter(o => !valid.has(o));
  if (bad.length > 0) {
    throw new McpError('INVALID_OWNER', `Unknown owner(s): ${bad.join(', ')}. Valid: ${[...valid].sort().join(', ')}`);
  }
  return list;
}

export function encodeCursor(offset: number, queryHash: string): string {
  return Buffer.from(JSON.stringify({ offset, queryHash })).toString('base64url');
}
export function decodeCursor(c: string): { offset: number; queryHash: string } {
  return JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
}
export function hashQuery(o: any): string { return Buffer.from(JSON.stringify(o)).toString('base64url').slice(0, 12); }
