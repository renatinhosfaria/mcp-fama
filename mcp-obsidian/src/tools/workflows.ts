// src/tools/workflows.ts
import { z } from 'zod';
import { ToolCtx, tryToolBody, ok, ownerCheck, validateOwners, validateTimeRange, mtimeInWindow } from './_shared.js';
import { readFileAtomic, writeFileAtomic, safeJoin, statFile, toKebabSlug, validateJournalFilename } from '../vault/fs.js';
import { parseFrontmatter, serializeFrontmatter } from '../vault/frontmatter.js';
import { McpError, McpToolResponse } from '../errors.js';
import { setLastWriteTs } from '../last-write.js';
import { log } from '../middleware/logger.js';
import { parseLeadBody, serializeLeadBody, type LeadBody, type LeadHeaders, type LeadInteraction, serializeInteractionBlock } from '../vault/lead.js';
import { parseBrokerBody, serializeBrokerBody, type BrokerBody, type BrokerHeaders, type BrokerInteraction, serializeInteractionBlock as serializeBrokerInteraction } from '../vault/broker.js';
import { parseRegressaoBody } from '../vault/regressao.js';
import { parseFinancialBody, serializeFinancialBody, extractFirstLine, type FinancialSections } from '../vault/financial.js';

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
    if (existing) throw new McpError('JOURNAL_IMMUTABLE', `Journal entry already exists: ${rel}. Journals are append-only; use append_to_note instead.`);

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

export interface DeltaGroups {
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

export async function computeAgentDelta(
  ctx: ToolCtx,
  agent: string,
  sinceMs: number,
  types: string[] | undefined,
  includeContent: boolean,
): Promise<DeltaGroups> {
  const groups: DeltaGroups = { decisions: [], journals: [], goals: [], results: [], shared_contexts: [], entity_profiles: [], other: [] };
  const typeFilter = types ? new Set(types) : null;

  for (const e of ctx.index.byOwner(agent)) {
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
    if (includeContent) item.content = content;
    groups[bucket(e.path)].push(item);
  }
  return groups;
}

export async function getAgentDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetAgentDeltaSchema.parse(args);
    const sinceMs = Date.parse(a.since);
    if (isNaN(sinceMs)) throw new McpError('VAULT_IO_ERROR', 'since must be ISO-8601');
    return await computeAgentDelta(ctx, a.agent, sinceMs, a.types, a.include_content);
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  const total = Object.values(sc).reduce<number>((acc, v: any) => acc + (v as any[]).length, 0);
  return ok(sc, `Delta: ${total} entries`);
}

// ─── get_shared_context_delta ────────────────────────────────────────────────

export const GetSharedContextDeltaSchema = z.object({
  since: z.string(),
  topics: z.array(z.string()).optional(),
  owners: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

function topicFromSharedContextPath(rel: string): string | null {
  // _shared/context/<topic>/<agent>/<slug>.md
  const parts = rel.split('/');
  if (parts.length < 5) return null;
  if (parts[0] !== '_shared' || parts[1] !== 'context') return null;
  return parts[2];
}

export async function getSharedContextDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetSharedContextDeltaSchema.parse(args);
    // validateTimeRange throws INVALID_TIME_RANGE on malformed since
    const window = validateTimeRange(a.since, undefined);
    const sinceMs = window.sinceMs!;
    const ownerList = await validateOwners(ctx, a.owners);
    const topicFilter = a.topics ? new Set(a.topics) : null;
    const ownerFilter = ownerList ? new Set(ownerList) : null;

    const byTopic: Record<string, any[]> = {};
    let total = 0;

    for (const e of ctx.index.byType('shared-context')) {
      if (e.mtimeMs <= sinceMs) continue;
      const topic = topicFromSharedContextPath(e.path);
      if (!topic) continue;
      if (topicFilter && !topicFilter.has(topic)) continue;
      if (ownerFilter && (!e.owner || !ownerFilter.has(e.owner))) continue;

      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
      catch { continue; }

      const item: any = {
        path: e.path,
        owner: e.owner,
        updated: e.updated,
        mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter,
        preview: content.slice(0, 500),
      };
      if (a.include_content) item.content = content;

      if (!byTopic[topic]) byTopic[topic] = [];
      byTopic[topic].push(item);
      total++;
    }
    return { by_topic: byTopic, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Shared context delta: ${v.total} entries across ${Object.keys(v.by_topic).length} topics`);
}

// ─── get_training_target_delta ───────────────────────────────────────────────

export const GetTrainingTargetDeltaSchema = z.object({
  target_agent: z.string().min(1),
  since: z.string(),
  topics: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

export async function getTrainingTargetDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetTrainingTargetDeltaSchema.parse(args);
    const window = validateTimeRange(a.since, undefined);
    const sinceMs = window.sinceMs!;
    const topicFilter = a.topics ? new Set(a.topics) : null;
    const targetTag = `#alvo-${a.target_agent}`;

    // 1) target_agent_delta (unfiltered by topics)
    const target_agent_delta = await computeAgentDelta(ctx, a.target_agent, sinceMs, undefined, a.include_content);

    // 2) shared_about_target: shared-context from OTHER owners mentioning target via #alvo-<target> tag OR body Agente alvo
    const sharedAboutMap = new Map<string, any>();
    for (const e of ctx.index.byType('shared-context')) {
      if (e.mtimeMs <= sinceMs) continue;
      if (e.owner === a.target_agent) continue; // self-exclusion per spec
      const topic = topicFromSharedContextPath(e.path);
      if (!topic) continue;
      if (topicFilter && !topicFilter.has(topic)) continue;

      const tagMatch = Array.isArray(e.tags) && e.tags.includes(targetTag);
      let bodyMatch = false;
      let content: string | null = null;
      if (!tagMatch && topic === 'regressoes') {
        // Parse body for `## Agente alvo` section
        try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
        catch { continue; }
        const parsed = parseFrontmatter(content);
        const reg = parseRegressaoBody(parsed.body);
        if (reg.agente_alvo === a.target_agent) bodyMatch = true;
      }
      if (!tagMatch && !bodyMatch) continue;

      if (content === null) {
        try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
        catch { continue; }
      }

      const item: any = {
        path: e.path,
        owner: e.owner,
        topic,
        mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter,
        preview: content.slice(0, 500),
      };
      if (a.include_content) item.content = content;
      sharedAboutMap.set(e.path, item);
    }
    const shared_about_target = [...sharedAboutMap.values()];

    // 3) regressions: subset of shared_about_target where topic === 'regressoes', with body fields projected
    const regressions: any[] = [];
    for (const item of shared_about_target) {
      if (item.topic !== 'regressoes') continue;
      let fullContent = item.content;
      if (!fullContent) {
        try { ({ content: fullContent } = await readFileAtomic(safeJoin(ctx.vaultRoot, item.path))); }
        catch { continue; }
      }
      const parsed = parseFrontmatter(fullContent);
      const reg = parseRegressaoBody(parsed.body);
      regressions.push({
        ...item,
        status: reg.status,
        severidade: reg.severidade,
        categoria: reg.categoria,
      });
    }

    const target_agent_delta_total = Object.values(target_agent_delta).reduce<number>((acc, v: any) => acc + v.length, 0);
    const total = target_agent_delta_total + shared_about_target.length + regressions.length;

    return { target_agent_delta, shared_about_target, regressions, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Training-target delta for '${(args as any).target_agent}': ${v.total} entries (agent+shared+regressions)`);
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

// ─── search_by_tag / search_by_type / get_backlinks ──────────────────────────

export const SearchByTagSchema = z.object({
  tag: z.string().min(1),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

export async function searchByTag(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = SearchByTagSchema.parse(args);
    const timeWindow = validateTimeRange(a.since, a.until);
    const owners = await validateOwners(ctx, a.owner);
    let notes = ctx.index.byTag(a.tag);
    if (owners) notes = notes.filter(e => e.owner !== null && owners.includes(e.owner));
    if (timeWindow.sinceMs !== null || timeWindow.untilMs !== null) {
      notes = notes.filter(e => mtimeInWindow(e.mtimeMs, timeWindow));
    }
    return { notes: notes.map(e => ({ path: e.path, type: e.type, owner: e.owner })) };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} note(s) tagged`);
}

export const SearchByTypeSchema = z.object({
  type: z.string().min(1),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

export async function searchByType(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = SearchByTypeSchema.parse(args);
    const timeWindow = validateTimeRange(a.since, a.until);
    const owners = await validateOwners(ctx, a.owner);
    let notes = ctx.index.byType(a.type);
    if (owners) notes = notes.filter(e => e.owner !== null && owners.includes(e.owner));
    if (timeWindow.sinceMs !== null || timeWindow.untilMs !== null) {
      notes = notes.filter(e => mtimeInWindow(e.mtimeMs, timeWindow));
    }
    return { notes: notes.map(e => ({ path: e.path, type: e.type, owner: e.owner })) };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} note(s) of type`);
}

export const GetBacklinksSchema = z.object({ note_name: z.string().min(1) });

export async function getBacklinks(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetBacklinksSchema.parse(args);
    return { notes: ctx.index.backlinks(a.note_name).map(e => ({ path: e.path, line: 0 })) };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} backlink(s)`);
}

// ─── upsert_lead_timeline ────────────────────────────────────────────────────

export const UpsertLeadTimelineSchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  resumo: z.string().optional(),
  interesse_atual: z.string().optional(),
  objecoes_ativas: z.array(z.string()).optional(),
  proximo_passo: z.string().optional(),
  status_comercial: z.string().optional(),
  origem: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
});

export async function upsertLeadTimeline(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertLeadTimelineSchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: LeadBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseLeadBody(parsed.body);
    }

    const mergedHeaders: LeadHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      interesse_atual: a.interesse_atual !== undefined ? a.interesse_atual : priorBody?.headers.interesse_atual ?? null,
      objecoes_ativas: a.objecoes_ativas !== undefined ? a.objecoes_ativas : priorBody?.headers.objecoes_ativas ?? null,
      proximo_passo: a.proximo_passo !== undefined ? a.proximo_passo : priorBody?.headers.proximo_passo ?? null,
    };

    const newBody: LeadBody = {
      headers: mergedHeaders,
      interactions: priorBody?.interactions ?? [],
      malformed_blocks: [],
    };

    const fm: Record<string, any> = {
      type: 'entity-profile',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags.length > 0 ? a.tags : (priorFm?.tags ?? []),
      entity_type: 'lead',
      entity_name: a.lead_name,
    };
    if (a.status_comercial !== undefined) fm.status_comercial = a.status_comercial;
    else if (priorFm?.status_comercial) fm.status_comercial = priorFm.status_comercial;
    if (a.origem !== undefined) fm.origem = a.origem;
    else if (priorFm?.origem) fm.origem = priorFm.origem;
    if (mergedHeaders.interesse_atual) fm.interesse_atual = mergedHeaders.interesse_atual;
    if (mergedHeaders.objecoes_ativas) fm.objecoes_ativas = mergedHeaders.objecoes_ativas;
    if (mergedHeaders.proximo_passo) fm.proximo_passo = mergedHeaders.proximo_passo;

    await writeFileAtomic(safe, serializeFrontmatter(fm, serializeLeadBody(newBody)));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_lead_timeline', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

// ─── append_lead_interaction ─────────────────────────────────────────────────

export const AppendLeadInteractionSchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  channel: z.string().min(1),
  summary: z.string().min(1),
  origem: z.string().optional(),
  objection: z.string().optional(),
  next_step: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  timestamp: z.string().datetime().optional(),
});

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export async function appendLeadInteraction(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendLeadInteractionSchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) {
      throw new McpError('LEAD_NOT_FOUND', `Lead doc not found: ${rel}. Run upsert_lead_timeline first.`);
    }

    const ts = formatTimestamp(a.timestamp ?? new Date().toISOString());
    const interaction: LeadInteraction = {
      timestamp: ts,
      channel: a.channel,
      origem: a.origem ?? null,
      summary: a.summary,
      objection: a.objection ?? null,
      next_step: a.next_step ?? null,
      tags: a.tags,
    };

    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    const body = parsed.body;

    let newBodyText: string;
    if (body.includes('## Histórico de interações')) {
      newBodyText = body.trimEnd() + '\n\n' + serializeInteractionBlock(interaction) + '\n';
    } else {
      newBodyText = body.trimEnd() + '\n\n## Histórico de interações\n\n' + serializeInteractionBlock(interaction) + '\n';
    }

    const fm = { ...(parsed.frontmatter ?? {}), updated: today() };
    const fullNew = serializeFrontmatter(fm, newBodyText);
    const appendBytes = fullNew.length - raw.length;

    await writeFileAtomic(safe, fullNew);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_lead_interaction', as_agent: a.as_agent, path: rel, action: 'append', outcome: 'ok' });
    return { path: rel, bytes_appended: appendBytes, block_inserted_at: ts };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Appended interaction at ${(r.value as any).block_inserted_at} to ${(r.value as any).path}`);
}

// ─── read_lead_history ───────────────────────────────────────────────────────

export const ReadLeadHistorySchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export async function readLeadHistory(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadLeadHistorySchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('LEAD_NOT_FOUND', `Lead doc not found: ${rel}. Run upsert_lead_timeline first.`);

    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const lead = parseLeadBody(body);

    let interactions = lead.interactions;

    if (a.since) {
      const sinceTs = formatTimestamp(a.since);
      interactions = interactions.filter(i => i.timestamp >= sinceTs);
    }
    interactions = [...interactions].sort((x, y) => a.order === 'asc'
      ? x.timestamp.localeCompare(y.timestamp)
      : y.timestamp.localeCompare(x.timestamp));
    if (a.limit) interactions = interactions.slice(0, a.limit);

    const warnings = lead.malformed_blocks.map(m => ({ code: 'MALFORMED_LEAD_BODY', line: m.line, reason: m.reason }));

    return {
      lead: {
        entity_name: frontmatter?.entity_name ?? a.lead_name,
        status_comercial: frontmatter?.status_comercial ?? null,
        origem: frontmatter?.origem ?? null,
        resumo: lead.headers.resumo,
        interesse_atual: lead.headers.interesse_atual,
        objecoes_ativas: lead.headers.objecoes_ativas,
        proximo_passo: lead.headers.proximo_passo,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Lead '${(r.value as any).lead.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}

// ─── upsert_broker_profile ───────────────────────────────────────────────────

export const UpsertBrokerProfileSchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  resumo: z.string().optional(),
  comunicacao: z.string().optional(),
  padroes_atendimento: z.string().optional(),
  pendencias_abertas: z.array(z.string()).optional(),
  equipe: z.string().optional(),
  nivel_engajamento: z.string().optional(),
  comunicacao_estilo: z.string().optional(),
  contato_email: z.string().optional(),
  contato_whatsapp: z.string().optional(),
  dificuldades_recorrentes: z.array(z.string()).optional(),
  nivel_atencao: z.string().optional(),
  ultima_acao_recomendada: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
});

export async function upsertBrokerProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertBrokerProfileSchema.parse(args);
    if (typeof a.ultima_acao_recomendada === 'string' && a.ultima_acao_recomendada.includes('\n')) {
      throw new McpError('INVALID_FRONTMATTER', 'ultima_acao_recomendada must be one line (no newline)');
    }
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: BrokerBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseBrokerBody(parsed.body);
    }

    const mergedHeaders: BrokerHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      comunicacao: a.comunicacao !== undefined ? a.comunicacao : priorBody?.headers.comunicacao ?? null,
      padroes_atendimento: a.padroes_atendimento !== undefined ? a.padroes_atendimento : priorBody?.headers.padroes_atendimento ?? null,
      pendencias_abertas: a.pendencias_abertas !== undefined ? a.pendencias_abertas : priorBody?.headers.pendencias_abertas ?? null,
    };

    const newBody: BrokerBody = {
      headers: mergedHeaders,
      interactions: priorBody?.interactions ?? [],
      malformed_blocks: [],
    };

    const fm: Record<string, any> = {
      type: 'entity-profile',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags.length > 0 ? a.tags : (priorFm?.tags ?? []),
      entity_type: 'broker',
      entity_name: a.broker_name,
    };
    for (const field of ['equipe', 'nivel_engajamento', 'comunicacao_estilo', 'contato_email', 'contato_whatsapp', 'padroes_atendimento', 'nivel_atencao', 'ultima_acao_recomendada'] as const) {
      const passed = (a as any)[field];
      if (passed !== undefined) fm[field] = passed;
      else if (priorFm?.[field] !== undefined) fm[field] = priorFm[field];
    }
    for (const listField of ['dificuldades_recorrentes', 'pendencias_abertas'] as const) {
      const passed = (a as any)[listField];
      if (passed !== undefined) fm[listField] = passed;
      else if (priorFm?.[listField] !== undefined) fm[listField] = priorFm[listField];
    }
    if (mergedHeaders.pendencias_abertas !== null) fm.pendencias_abertas = mergedHeaders.pendencias_abertas;

    await writeFileAtomic(safe, serializeFrontmatter(fm, serializeBrokerBody(newBody)));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_broker_profile', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

// ─── append_broker_interaction ───────────────────────────────────────────────

export const AppendBrokerInteractionSchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  channel: z.string().min(1),
  summary: z.string().min(1),
  contexto_lead: z.string().optional(),
  dificuldade: z.string().optional(),
  encaminhamento: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  timestamp: z.string().datetime().optional(),
});

export async function appendBrokerInteraction(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendBrokerInteractionSchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}. Run upsert_broker_profile first.`);

    const ts = formatTimestamp(a.timestamp ?? new Date().toISOString());
    const interaction: BrokerInteraction = {
      timestamp: ts,
      channel: a.channel,
      contexto_lead: a.contexto_lead ?? null,
      summary: a.summary,
      dificuldade: a.dificuldade ?? null,
      encaminhamento: a.encaminhamento ?? null,
      tags: a.tags,
    };

    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    const body = parsed.body;
    let newBodyText: string;
    if (body.includes('## Histórico de interações')) {
      newBodyText = body.trimEnd() + '\n\n' + serializeBrokerInteraction(interaction) + '\n';
    } else {
      newBodyText = body.trimEnd() + '\n\n## Histórico de interações\n\n' + serializeBrokerInteraction(interaction) + '\n';
    }
    const fm = { ...(parsed.frontmatter ?? {}), updated: today() };
    const fullNew = serializeFrontmatter(fm, newBodyText);
    const appendBytes = fullNew.length - raw.length;

    await writeFileAtomic(safe, fullNew);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_broker_interaction', as_agent: a.as_agent, path: rel, action: 'append', outcome: 'ok' });
    return { path: rel, bytes_appended: appendBytes, block_inserted_at: ts };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Appended broker interaction at ${(r.value as any).block_inserted_at}`);
}

// ─── read_broker_history ─────────────────────────────────────────────────────

export const ReadBrokerHistorySchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export async function readBrokerHistory(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadBrokerHistorySchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}.`);

    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const broker = parseBrokerBody(body);

    let interactions = broker.interactions;
    if (a.since) {
      const sinceTs = formatTimestamp(a.since);
      interactions = interactions.filter(i => i.timestamp >= sinceTs);
    }
    interactions = [...interactions].sort((x, y) => a.order === 'asc'
      ? x.timestamp.localeCompare(y.timestamp)
      : y.timestamp.localeCompare(x.timestamp));
    if (a.limit) interactions = interactions.slice(0, a.limit);

    const warnings = broker.malformed_blocks.map(m => ({ code: 'MALFORMED_BROKER_BODY', line: m.line, reason: m.reason }));

    return {
      broker: {
        entity_name: frontmatter?.entity_name ?? a.broker_name,
        equipe: frontmatter?.equipe ?? null,
        nivel_engajamento: frontmatter?.nivel_engajamento ?? null,
        comunicacao_estilo: frontmatter?.comunicacao_estilo ?? null,
        contato_email: frontmatter?.contato_email ?? null,
        contato_whatsapp: frontmatter?.contato_whatsapp ?? null,
        dificuldades_recorrentes: frontmatter?.dificuldades_recorrentes ?? null,
        pendencias_abertas: broker.headers.pendencias_abertas ?? frontmatter?.pendencias_abertas ?? null,
        resumo: broker.headers.resumo,
        comunicacao: broker.headers.comunicacao,
        padroes_atendimento: broker.headers.padroes_atendimento,
        nivel_atencao: frontmatter?.nivel_atencao ?? null,
        ultima_acao_recomendada: frontmatter?.ultima_acao_recomendada ?? null,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Broker '${(r.value as any).broker.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}

// ─── upsert_financial_snapshot + read_financial_series ───────────────────────

const periodReFinancial = /^\d{4}-(0[1-9]|1[0-2])$/;

export const UpsertFinancialSnapshotSchema = z.object({
  as_agent: z.string().min(1),
  period: z.string(),
  caixa: z.string().optional(),
  receita: z.string().optional(),
  despesa: z.string().optional(),
  alertas: z.array(z.string()).optional(),
  contexto: z.string().optional(),
  caixa_resumo: z.string().optional(),
  receita_resumo: z.string().optional(),
  despesa_resumo: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export async function upsertFinancialSnapshot(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertFinancialSnapshotSchema.parse(args);
    if (!periodReFinancial.test(a.period)) {
      throw new McpError('INVALID_PERIOD', `period must be YYYY-MM (got '${a.period}')`);
    }
    for (const key of ['caixa_resumo', 'receita_resumo', 'despesa_resumo'] as const) {
      const v = (a as any)[key];
      if (typeof v === 'string' && v.includes('\n')) {
        throw new McpError('INVALID_FRONTMATTER', `${key} must be one line (no newline)`);
      }
    }

    const rel = `_shared/financials/${a.period}/${a.as_agent}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);

    // Load prior sections if update
    let priorFm: Record<string, any> | null = null;
    let priorSections: FinancialSections = { caixa: null, receita: null, despesa: null, alertas: null, contexto: null };
    if (existing) {
      const { content } = await readFileAtomic(safe);
      const parsed = parseFrontmatter(content);
      priorFm = parsed.frontmatter;
      priorSections = parseFinancialBody(parsed.body);
    }

    // Merge: undefined → keep prior; provided → override
    const merged: FinancialSections = {
      caixa:    a.caixa    !== undefined ? (a.caixa    === '' ? null : a.caixa)    : priorSections.caixa,
      receita:  a.receita  !== undefined ? (a.receita  === '' ? null : a.receita)  : priorSections.receita,
      despesa:  a.despesa  !== undefined ? (a.despesa  === '' ? null : a.despesa)  : priorSections.despesa,
      alertas:  a.alertas  !== undefined ? a.alertas                                : priorSections.alertas,
      contexto: a.contexto !== undefined ? (a.contexto === '' ? null : a.contexto) : priorSections.contexto,
    };

    // Auto-extract *_resumo from merged body if not explicitly passed; else use prior fm
    const caixaResumo = a.caixa_resumo !== undefined
      ? (a.caixa_resumo === '' ? null : a.caixa_resumo)
      : (a.caixa !== undefined
          ? extractFirstLine(merged.caixa)
          : (priorFm?.caixa_resumo ?? extractFirstLine(merged.caixa)));
    const receitaResumo = a.receita_resumo !== undefined
      ? (a.receita_resumo === '' ? null : a.receita_resumo)
      : (a.receita !== undefined
          ? extractFirstLine(merged.receita)
          : (priorFm?.receita_resumo ?? extractFirstLine(merged.receita)));
    const despesaResumo = a.despesa_resumo !== undefined
      ? (a.despesa_resumo === '' ? null : a.despesa_resumo)
      : (a.despesa !== undefined
          ? extractFirstLine(merged.despesa)
          : (priorFm?.despesa_resumo ?? extractFirstLine(merged.despesa)));
    const alertasCount = merged.alertas !== null ? merged.alertas.length : 0;

    const fm: Record<string, any> = {
      type: 'financial-snapshot',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags ?? priorFm?.tags ?? [],
      period: a.period,
      alertas_count: alertasCount,
    };
    if (caixaResumo   !== null) fm.caixa_resumo   = caixaResumo;
    if (receitaResumo !== null) fm.receita_resumo = receitaResumo;
    if (despesaResumo !== null) fm.despesa_resumo = despesaResumo;

    const body = serializeFinancialBody(merged);
    await writeFileAtomic(safe, serializeFrontmatter(fm, body));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_financial_snapshot', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const ReadFinancialSeriesSchema = z.object({
  as_agent: z.string().min(1),
  periods: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().optional().default(12),
  order: z.enum(['desc', 'asc']).optional().default('desc'),
});

export async function readFinancialSeries(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadFinancialSeriesSchema.parse(args);

    // Validate period-shaped filters when provided (since/until or explicit periods)
    const validatePeriodStr = (p: string, field: string) => {
      if (!periodReFinancial.test(p)) {
        throw new McpError('INVALID_PERIOD', `${field} must be YYYY-MM (got '${p}')`);
      }
    };
    if (a.since)  validatePeriodStr(a.since,  'since');
    if (a.until)  validatePeriodStr(a.until,  'until');
    if (a.periods) for (const p of a.periods) validatePeriodStr(p, 'periods[]');
    if (a.since && a.until && a.since > a.until) {
      throw new McpError('INVALID_TIME_RANGE', `since (${a.since}) must be <= until (${a.until})`);
    }

    // Mode (a): explicit periods[] → each must exist or SNAPSHOT_NOT_FOUND
    let selectedPeriods: string[];
    if (a.periods) {
      const missing: string[] = [];
      const found: string[] = [];
      for (const p of a.periods) {
        const rel = `_shared/financials/${p}/${a.as_agent}.md`;
        if (ctx.index.get(rel)) found.push(p); else missing.push(p);
      }
      if (missing.length > 0) {
        throw new McpError('SNAPSHOT_NOT_FOUND', `Missing snapshots for ${a.as_agent}: ${missing.join(', ')}`);
      }
      selectedPeriods = found;
      if (a.since)  selectedPeriods = selectedPeriods.filter(p => p >= a.since!);
      if (a.until)  selectedPeriods = selectedPeriods.filter(p => p <= a.until!);
    } else {
      // Mode (b): scan index for all financials for as_agent; filter by since/until
      const prefix = '_shared/financials/';
      const suffix = `/${a.as_agent}.md`;
      const all: string[] = [];
      for (const e of ctx.index.allEntries()) {
        if (!e.path.startsWith(prefix) || !e.path.endsWith(suffix)) continue;
        const period = e.path.slice(prefix.length, e.path.length - suffix.length);
        if (!periodReFinancial.test(period)) continue;
        all.push(period);
      }
      selectedPeriods = all;
      if (a.since) selectedPeriods = selectedPeriods.filter(p => p >= a.since!);
      if (a.until) selectedPeriods = selectedPeriods.filter(p => p <= a.until!);
    }

    // Sort lexicographic + order
    selectedPeriods.sort();
    if (a.order === 'desc') selectedPeriods.reverse();
    selectedPeriods = selectedPeriods.slice(0, a.limit);

    // Parse each snapshot
    const snapshots: any[] = [];
    for (const period of selectedPeriods) {
      const rel = `_shared/financials/${period}/${a.as_agent}.md`;
      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, rel))); }
      catch { continue; }
      const parsed = parseFrontmatter(content);
      const sections = parseFinancialBody(parsed.body);
      snapshots.push({
        period,
        frontmatter: parsed.frontmatter,
        caixa: sections.caixa,
        receita: sections.receita,
        despesa: sections.despesa,
        alertas: sections.alertas,
        contexto: sections.contexto,
      });
    }

    return { snapshots };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Financial series for ${(args as any).as_agent}: ${v.snapshots.length} snapshot(s)`);
}
