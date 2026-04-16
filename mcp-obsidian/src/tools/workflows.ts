// src/tools/workflows.ts
import { z } from 'zod';
import { ToolCtx, tryToolBody, ok, ownerCheck } from './_shared.js';
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
