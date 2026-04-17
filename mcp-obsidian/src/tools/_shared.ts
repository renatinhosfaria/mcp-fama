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

export interface TimeWindow { sinceMs: number | null; untilMs: number | null; }

export function validateTimeRange(since?: string, until?: string): TimeWindow {
  let sinceMs: number | null = null;
  let untilMs: number | null = null;
  if (since !== undefined) {
    const t = Date.parse(since);
    if (isNaN(t)) throw new McpError('INVALID_TIME_RANGE', `'since' is not valid ISO-8601: '${since}'`);
    sinceMs = t;
  }
  if (until !== undefined) {
    const t = Date.parse(until);
    if (isNaN(t)) throw new McpError('INVALID_TIME_RANGE', `'until' is not valid ISO-8601: '${until}'`);
    untilMs = t;
  }
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    throw new McpError('INVALID_TIME_RANGE', `'since' must be ≤ 'until' (since=${since}, until=${until})`);
  }
  return { sinceMs, untilMs };
}

export function mtimeInWindow(mtimeMs: number, window: TimeWindow): boolean {
  if (window.sinceMs !== null && mtimeMs < window.sinceMs) return false;
  if (window.untilMs !== null && mtimeMs > window.untilMs) return false;
  return true;
}

const RELATIVE_RE = /^(\d+)([dwmy])$/;

export function parseRelativeOrIsoSince(since: string, nowMs: number): number {
  const m = since.match(RELATIVE_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const unitMs = unit === 'd' ? 86400_000
                 : unit === 'w' ? 7 * 86400_000
                 : unit === 'm' ? 30 * 86400_000
                 : unit === 'y' ? 365 * 86400_000
                 : 0;
    return nowMs - n * unitMs;
  }
  const iso = Date.parse(since);
  if (!isNaN(iso)) return iso;
  throw new McpError('INVALID_RELATIVE_TIME', `since must match '^\\d+[dwmy]$' (e.g. '7d', '1w', '2m', '1y') or be ISO-8601; got '${since}'`);
}
