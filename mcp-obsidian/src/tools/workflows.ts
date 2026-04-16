// src/tools/workflows.ts
import { z } from 'zod';
import { ToolCtx, tryToolBody, ok, ownerCheck, validateOwners } from './_shared.js';
import { readFileAtomic, writeFileAtomic, safeJoin, statFile, toKebabSlug, validateJournalFilename } from '../vault/fs.js';
import { parseFrontmatter, serializeFrontmatter } from '../vault/frontmatter.js';
import { McpError, McpToolResponse } from '../errors.js';
import { setLastWriteTs } from '../last-write.js';
import { log } from '../middleware/logger.js';

function today(): string { return new Date().toISOString().slice(0, 10); }

// ─── create_journal_entry ────────────────────────────────────────────────────

export const CreateJournalEntrySchema = z.object({
  agent: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
});

export async function createJournalEntry(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = CreateJournalEntrySchema.parse(args);
    const slug = toKebabSlug(a.title);
    if (slug === '') throw new McpError('INVALID_FILENAME', `title '${a.title}' produces empty slug`);
    const date = today();
    const filename = `${date}-${slug}.md`;
    validateJournalFilename(filename);
    const rel = `_agents/${a.agent}/journal/${filename}`;

    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (existing) throw new McpError('IMMUTABLE_TARGET', `Journal entry already exists: ${rel}. Journals are append-only; use append_to_note.`);

    const fm = {
      type: 'journal', owner: a.agent,
      created: date, updated: date,
      tags: a.tags, title: a.title,
    };
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'create_journal_entry', as_agent: a.agent, path: rel, action: 'create', outcome: 'ok' });
    return { path: rel, created: true };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Created ${(r.value as any).path}`);
}

// ─── append_decision ─────────────────────────────────────────────────────────

export const AppendDecisionSchema = z.object({
  agent: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
});

export async function appendDecision(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendDecisionSchema.parse(args);
    const rel = `_agents/${a.agent}/decisions.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const { content } = await readFileAtomic(safe);
    const parsed = parseFrontmatter(content);
    const fm = { ...(parsed.frontmatter ?? { type: 'agent-decisions', owner: a.agent, created: today(), updated: today(), tags: [] }), updated: today() };
    const newBlock = `## ${today()} — ${a.title}\n\n${a.rationale}\n`;
    const newBody = newBlock + '\n' + (parsed.body.startsWith('\n') ? parsed.body.slice(1) : parsed.body);
    await writeFileAtomic(safe, serializeFrontmatter(fm, newBody));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_decision', as_agent: a.agent, path: rel, action: 'prepend', outcome: 'ok' });
    return { path: rel, prepended: true };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Prepended decision to ${(r.value as any).path}`);
}

// ─── update_agent_profile ────────────────────────────────────────────────────

export const UpdateAgentProfileSchema = z.object({
  agent: z.string().min(1),
  content: z.string(),
});

export async function updateAgentProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpdateAgentProfileSchema.parse(args);
    const rel = `_agents/${a.agent}/profile.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await readFileAtomic(safe);
    const parsed = parseFrontmatter(existing.content);
    const fm = { ...(parsed.frontmatter ?? { type: 'agent-profile', owner: a.agent, created: today(), updated: today(), tags: [] }), updated: today() };
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'update_agent_profile', as_agent: a.agent, path: rel, action: 'update', outcome: 'ok' });
    return { path: rel };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Updated ${(r.value as any).path}`);
}

// ─── upsert_goal + upsert_result ─────────────────────────────────────────────

const periodRe = /^\d{4}-\d{2}$/;

export const UpsertGoalSchema = z.object({
  agent: z.string().min(1),
  period: z.string().regex(periodRe, 'period must be YYYY-MM'),
  content: z.string(),
});

async function upsertPeriodic(kind: 'goal' | 'result', args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertGoalSchema.parse(args);
    const folder = kind === 'goal' ? 'goals' : 'results';
    const rel = `_shared/${folder}/${a.period}/${a.agent}.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    const priorFm = existing ? parseFrontmatter((await readFileAtomic(safe)).content).frontmatter : null;
    const fm = {
      type: kind, owner: a.agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: priorFm?.tags ?? [],
      period: a.period,
    };
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: `upsert_${kind}`, as_agent: a.agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const upsertGoal = (args: unknown, ctx: ToolCtx) => upsertPeriodic('goal', args, ctx);
export const upsertResult = (args: unknown, ctx: ToolCtx) => upsertPeriodic('result', args, ctx);

// ─── read_agent_context ──────────────────────────────────────────────────────

export const ReadAgentContextSchema = z.object({
  agent: z.string().min(1),
  n_decisions: z.number().int().positive().optional().default(5),
  n_journals: z.number().int().positive().optional().default(5),
});

function toSummary(e: any) {
  return { path: e.path, type: e.type, owner: e.owner, updated: e.updated, tags: e.tags, mtime: new Date(e.mtimeMs).toISOString() };
}

export async function readAgentContext(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadAgentContextSchema.parse(args);
    const profileEntry = ctx.index.get(`_agents/${a.agent}/profile.md`);
    const profile = profileEntry ? { ...toSummary(profileEntry), frontmatter: profileEntry.frontmatter } : null;

    const decisionsEntry = ctx.index.get(`_agents/${a.agent}/decisions.md`);
    let decisions: any[] = [];
    if (decisionsEntry) {
      const { content } = await readFileAtomic(safeJoin(ctx.vaultRoot, decisionsEntry.path));
      const body = parseFrontmatter(content).body;
      const blocks = body.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(s => s.trim().startsWith('## '));
      decisions = blocks.slice(0, a.n_decisions).map(b => {
        const firstLine = b.split('\n', 1)[0];
        const m = firstLine.match(/^## (\d{4}-\d{2}-\d{2}) — (.+)$/);
        return { date: m?.[1] ?? null, title: m?.[2] ?? firstLine.replace(/^##\s*/, ''), body: b };
      });
    }

    const journals = ctx.index.byOwner(a.agent)
      .filter(e => e.type === 'journal')
      .sort((x, y) => y.mtimeMs - x.mtimeMs)
      .slice(0, a.n_journals)
      .map(toSummary);
    const goals = ctx.index.byOwner(a.agent).filter(e => e.type === 'goal').map(toSummary);
    const results = ctx.index.byOwner(a.agent).filter(e => e.type === 'result').map(toSummary);

    return { profile, decisions, journals, goals, results };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `Context for ${(args as any).agent}: ${sc.decisions.length} decisions, ${sc.journals.length} journals, ${sc.goals.length} goals, ${sc.results.length} results`);
}
// ─── get_agent_delta ─────────────────────────────────────────────────────────

export const GetAgentDeltaSchema = z.object({
  agent: z.string().min(1),
  since: z.string().datetime(),
  types: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

interface DeltaGroups {
  decisions: any[]; journals: any[]; goals: any[]; results: any[];
  shared_contexts: any[]; entity_profiles: any[]; other: any[];
}

function bucket(pth: string): keyof DeltaGroups {
  if (/^_agents\/[^/]+\/decisions\.md$/.test(pth)) return 'decisions';
  if (/^_agents\/[^/]+\/journal\//.test(pth)) return 'journals';
  if (/^_shared\/goals\//.test(pth)) return 'goals';
  if (/^_shared\/results\//.test(pth)) return 'results';
  if (/^_shared\/context\//.test(pth)) return 'shared_contexts';
  if (/^_agents\/[^/]+\/(?!README\.md|profile\.md|decisions\.md|journal\/)[^/]+\/[^/]+\.md$/.test(pth)) return 'entity_profiles';
  return 'other';
}

export async function getAgentDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetAgentDeltaSchema.parse(args);
    const sinceMs = Date.parse(a.since);
    if (isNaN(sinceMs)) throw new McpError('VAULT_IO_ERROR', 'since must be ISO-8601');
    const groups: DeltaGroups = { decisions: [], journals: [], goals: [], results: [], shared_contexts: [], entity_profiles: [], other: [] };
    const typeFilter = a.types ? new Set(a.types) : null;

    for (const e of ctx.index.byOwner(a.agent)) {
      if (e.mtimeMs <= sinceMs) continue;
      if (typeFilter && (!e.type || !typeFilter.has(e.type))) continue;
      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
      catch { continue; }
      const item: any = {
        path: e.path, updated: e.updated, mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter,
        preview: content.slice(0, 500),
      };
      if (a.include_content) item.content = content;
      groups[bucket(e.path)].push(item);
    }
    return groups;
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  const total = Object.values(sc).reduce<number>((acc, v: any) => acc + (v as any[]).length, 0);
  return ok(sc, `Delta: ${total} entries`);
}

// ─── upsert_shared_context ───────────────────────────────────────────────────

const KEBAB_SEG = /^[a-z0-9][a-z0-9-]*$/;

export const UpsertSharedContextSchema = z.object({
  as_agent: z.string().min(1),
  topic: z.string().regex(KEBAB_SEG, 'topic must be kebab single-segment'),
  slug: z.string().regex(KEBAB_SEG, 'slug must be kebab single-segment'),
  title: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
});

export async function upsertSharedContext(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertSharedContextSchema.parse(args);
    const rel = `_shared/context/${a.topic}/${a.as_agent}/${a.slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    const priorFm = existing ? parseFrontmatter((await readFileAtomic(safe)).content).frontmatter : null;
    const fm = {
      type: 'shared-context', owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags,
      topic: a.topic,
      title: a.title,
    };
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_shared_context', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

// ─── upsert_entity_profile ───────────────────────────────────────────────────

export const UpsertEntityProfileSchema = z.object({
  as_agent: z.string().min(1),
  entity_type: z.string().regex(KEBAB_SEG, 'entity_type must be kebab single-segment'),
  entity_name: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
  status: z.string().optional(),
});

export async function upsertEntityProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertEntityProfileSchema.parse(args);
    const slug = toKebabSlug(a.entity_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `entity_name produces empty slug: '${a.entity_name}'`);
    const rel = `_agents/${a.as_agent}/${a.entity_type}/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    const priorFm = existing ? parseFrontmatter((await readFileAtomic(safe)).content).frontmatter : null;
    const fm: any = {
      type: 'entity-profile', owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags,
      entity_type: a.entity_type,
      entity_name: a.entity_name,
    };
    if (a.status !== undefined) fm.status = a.status;
    else if (priorFm?.status !== undefined) fm.status = priorFm.status;
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_entity_profile', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

