// src/tools/crud.ts
import { z } from 'zod';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { VaultIndex } from '../vault/index.js';
import { readFileAtomic, safeJoin, statFile, writeFileAtomic, appendFileAtomic, deleteFile, validateFilename } from '../vault/fs.js';
import { parseFrontmatter, serializeFrontmatter } from '../vault/frontmatter.js';
import { McpError, McpToolResponse } from '../errors.js';
import { setLastWriteTs } from '../last-write.js';
import { log } from '../middleware/logger.js';

export interface ToolCtx { index: VaultIndex; vaultRoot: string; }

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

export const ReadNoteSchema = z.object({ path: z.string().min(1) });

export async function readNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const { path: rel } = ReadNoteSchema.parse(args);
    const abs = safeJoin(ctx.vaultRoot, rel);
    const { content, mtimeMs } = await readFileAtomic(abs);
    const { frontmatter, body } = parseFrontmatter(content);
    const wl: string[] = [];
    for (const m of body.matchAll(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g)) wl.push(m[1].trim());
    const stem = path.basename(rel).replace(/\.md$/, '');
    const backlinksCount = ctx.index.backlinks(stem).length;
    return {
      frontmatter,
      content,
      path: rel,
      wikilinks: wl,
      backlinks_count: backlinksCount,
      bytes: Buffer.byteLength(content, 'utf8'),
      updated: frontmatter?.updated ?? null,
      mtime: new Date(mtimeMs).toISOString(),
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `Read ${r.value.path} (${r.value.bytes}b, ${r.value.wikilinks.length} wikilinks, ${r.value.backlinks_count} backlinks)`);
}

export const WriteNoteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  frontmatter: z.record(z.any()),
  as_agent: z.string().min(1),
});

export async function writeNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = WriteNoteSchema.parse(args);
    if (isDecisionsPath(a.path)) {
      throw new McpError('IMMUTABLE_TARGET', `decisions.md is append-only via append_decision, not write_note.`);
    }
    const filename = path.basename(a.path);
    validateFilename(filename);
    const safe = safeJoin(ctx.vaultRoot, a.path);

    await ownerCheck(ctx, a.path, a.as_agent);

    const fm = { ...a.frontmatter, owner: a.frontmatter.owner ?? a.as_agent };
    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);   // validates frontmatter via zod — throws INVALID_FRONTMATTER

    const exists = await statFile(safe);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(a.path);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'write_note', as_agent: a.as_agent, path: a.path, action: exists ? 'update' : 'create', outcome: 'ok' });

    return { path: a.path, created: !exists };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `${r.value.created ? 'Created' : 'Updated'} ${r.value.path}`);
}

export const AppendToNoteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  as_agent: z.string().min(1),
});

export async function appendToNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendToNoteSchema.parse(args);
    if (isDecisionsPath(a.path)) {
      throw new McpError('IMMUTABLE_TARGET', `decisions.md is append-only via append_decision tool, not append_to_note.`);
    }
    await ownerCheck(ctx, a.path, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, a.path);
    const r2 = await appendFileAtomic(safe, a.content);
    await ctx.index.updateAfterWrite(a.path);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_to_note', as_agent: a.as_agent, path: a.path, action: 'append', outcome: 'ok' });
    return { path: a.path, bytes_appended: r2.bytesAppended };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `Appended ${r.value.bytes_appended}b to ${r.value.path}`);
}

export const DeleteNoteSchema = z.object({
  path: z.string().min(1),
  as_agent: z.string().min(1),
  reason: z.string().min(1),
});

export async function deleteNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = DeleteNoteSchema.parse(args);
    await ownerCheck(ctx, a.path, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, a.path);
    await deleteFile(safe);
    await ctx.index.updateAfterWrite(a.path);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'delete_note', as_agent: a.as_agent, path: a.path, action: 'delete', reason: a.reason, outcome: 'ok' });
    return { path: a.path, deleted: true, reason: a.reason };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `Deleted ${r.value.path} (reason: ${r.value.reason})`);
}

// ─── H5: list_folder ────────────────────────────────────────────────────────

export function encodeCursor(offset: number, queryHash: string): string {
  return Buffer.from(JSON.stringify({ offset, queryHash })).toString('base64url');
}
export function decodeCursor(c: string): { offset: number; queryHash: string } {
  return JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
}
export function hashQuery(o: any): string { return Buffer.from(JSON.stringify(o)).toString('base64url').slice(0, 12); }

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

export const ListFolderSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional().default(false),
  filter_type: z.string().optional(),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
});

export async function listFolder(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ListFolderSchema.parse(args);
    const owners = await validateOwners(ctx, a.owner);

    const prefix = a.path.replace(/\/+$/, '') + '/';
    let entries = ctx.index.allEntries().filter(e => {
      if (a.path === '' || a.path === '/') return true;
      if (!a.recursive) {
        if (!e.path.startsWith(prefix)) return false;
        return !e.path.slice(prefix.length).includes('/');
      }
      return e.path.startsWith(prefix);
    });
    if (a.filter_type) entries = entries.filter(e => e.type === a.filter_type);
    if (owners) entries = entries.filter(e => e.owner !== null && owners.includes(e.owner));
    entries.sort((x, y) => x.path.localeCompare(y.path));

    const queryHash = hashQuery({ p: a.path, r: a.recursive, ft: a.filter_type, o: owners });
    let offset = 0;
    if (a.cursor) {
      const c = decodeCursor(a.cursor);
      if (c.queryHash !== queryHash) throw new McpError('VAULT_IO_ERROR', 'cursor query mismatch');
      offset = c.offset;
    }
    const page = entries.slice(offset, offset + a.limit);
    const nextOffset = offset + page.length;
    const next_cursor = nextOffset < entries.length ? encodeCursor(nextOffset, queryHash) : undefined;

    return {
      items: page.map(e => ({ path: e.path, type: e.type, owner: e.owner, updated: e.updated, tags: e.tags })),
      next_cursor,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).items.length} item(s)${(r.value as any).next_cursor ? ' (more)' : ''}`);
}
