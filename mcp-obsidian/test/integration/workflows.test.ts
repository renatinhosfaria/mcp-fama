// test/integration/workflows.test.ts
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { createJournalEntry } from '../../src/tools/workflows.js';
import { appendDecision } from '../../src/tools/workflows.js';
import { updateAgentProfile } from '../../src/tools/workflows.js';
import { upsertGoal, upsertResult } from '../../src/tools/workflows.js';
import { readAgentContext } from '../../src/tools/workflows.js';
import { getAgentDelta } from '../../src/tools/workflows.js';
import { upsertSharedContext } from '../../src/tools/workflows.js';
import { upsertEntityProfile } from '../../src/tools/workflows.js';
import { searchByTag, searchByType, getBacklinks } from '../../src/tools/workflows.js';
import { upsertLeadTimeline } from '../../src/tools/workflows.js';
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

// ─── create_journal_entry ────────────────────────────────────────────────────

describe('create_journal_entry', () => {
  const cleanup: string[] = [];
  afterEach(() => { for (const p of cleanup.splice(0)) if (fs.existsSync(p)) fs.unlinkSync(p); });

  it('creates a journal file with YYYY-MM-DD-slug path', async () => {
    const r = await createJournalEntry({ agent: 'alfa', title: 'Título de Teste', content: '# entry' }, ctx);
    const sc = r.structuredContent as any;
    expect(r.isError).toBeUndefined();
    expect(sc.path).toMatch(/^_agents\/alfa\/journal\/\d{4}-\d{2}-\d{2}-titulo-de-teste\.md$/);
    cleanup.push(path.join(FIXTURE, sc.path));
    expect(fs.existsSync(cleanup[cleanup.length - 1])).toBe(true);
  });

  it('INVALID_FILENAME on garbage-slug title', async () => {
    const r = await createJournalEntry({ agent: 'alfa', title: '!!!', content: 'x' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });
});

// ─── append_decision ─────────────────────────────────────────────────────────

describe('append_decision', () => {
  const backupPath = path.join(FIXTURE, '_agents/alfa/decisions.md');
  let original = '';
  beforeEach(() => { original = fs.readFileSync(backupPath, 'utf8'); });
  afterEach(async () => { fs.writeFileSync(backupPath, original); await ctx.index.updateAfterWrite('_agents/alfa/decisions.md'); });

  it('prepends a new block immediately after frontmatter', async () => {
    const r = await appendDecision({ agent: 'alfa', title: 'Nova decisão', rationale: 'porque sim' }, ctx);
    expect(r.isError).toBeUndefined();
    const content = fs.readFileSync(backupPath, 'utf8');
    const afterFm = content.split('---').slice(2).join('---');
    expect(afterFm.trimStart().startsWith(`## ${new Date().toISOString().slice(0, 10)} — Nova decisão`)).toBe(true);
    expect(content).toContain('first decision');
  });

  it('OWNERSHIP_VIOLATION when agent != owner', async () => {
    const r = await appendDecision({ agent: 'beta', title: 'x', rationale: 'y' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });
});

// ─── update_agent_profile ────────────────────────────────────────────────────

describe('update_agent_profile', () => {
  const target = path.join(FIXTURE, '_agents/alfa/profile.md');
  let original = '';
  beforeEach(() => { original = fs.readFileSync(target, 'utf8'); });
  afterEach(async () => { fs.writeFileSync(target, original); await ctx.index.updateAfterWrite('_agents/alfa/profile.md'); });

  it('rewrites profile body, preserves frontmatter', async () => {
    const r = await updateAgentProfile({ agent: 'alfa', content: '# new profile body' }, ctx);
    expect(r.isError).toBeUndefined();
    const content = fs.readFileSync(target, 'utf8');
    expect(content).toContain('# new profile body');
    expect(content).toContain('type: agent-profile');
  });
});

// ─── upsert_goal / upsert_result ─────────────────────────────────────────────

describe('upsert_goal / upsert_result', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const p of created.splice(0)) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const d = path.dirname(p);
      if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    }
  });

  it('upsert_goal writes to _shared/goals/<period>/<agent>.md', async () => {
    const r = await upsertGoal({ agent: 'alfa', period: '2026-04', content: '# my goals' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_shared/goals/2026-04/alfa.md');
    created.push(path.join(FIXTURE, sc.path));
    const content = fs.readFileSync(created[0], 'utf8');
    expect(content).toMatch(/type: goal/);
    expect(content).toMatch(/period: '?2026-04/);
    expect(content).toContain('# my goals');
  });

  it('upsert_result mirrors to _shared/results/...', async () => {
    const r = await upsertResult({ agent: 'alfa', period: '2026-04', content: '# my results' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_shared/results/2026-04/alfa.md');
    created.push(path.join(FIXTURE, sc.path));
  });

  it('INVALID_FRONTMATTER when period malformed', async () => {
    const r = await upsertGoal({ agent: 'alfa', period: '2026-4', content: 'x' }, ctx);
    expect(r.isError).toBe(true);
  });
});

// ─── read_agent_context ──────────────────────────────────────────────────────

describe('read_agent_context', () => {
  it('returns profile + decisions + journals + goals + results bundle', async () => {
    const r = await readAgentContext({ agent: 'alfa', n_decisions: 3, n_journals: 3 }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.profile).toBeTruthy();
    expect(sc.profile.path).toBe('_agents/alfa/profile.md');
    expect(Array.isArray(sc.decisions)).toBe(true);
    expect(sc.decisions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(sc.journals)).toBe(true);
    expect(Array.isArray(sc.goals)).toBe(true);
    expect(Array.isArray(sc.results)).toBe(true);
  });
});

// ─── get_agent_delta ─────────────────────────────────────────────────────────

describe('get_agent_delta', () => {
  it('returns entries grouped by type (decisions, journals, goals, results, shared_contexts, entity_profiles, other)', async () => {
    const e = ctx.index.get('_agents/alfa/decisions.md')!;
    const since = new Date(e.mtimeMs - 10_000).toISOString();
    const r = await getAgentDelta({ agent: 'alfa', since }, ctx);
    const sc = r.structuredContent as any;
    expect(Array.isArray(sc.decisions)).toBe(true);
    expect(Array.isArray(sc.journals)).toBe(true);
    expect(Array.isArray(sc.goals)).toBe(true);
    expect(Array.isArray(sc.results)).toBe(true);
    expect(Array.isArray(sc.shared_contexts)).toBe(true);
    expect(Array.isArray(sc.entity_profiles)).toBe(true);
    expect(Array.isArray(sc.other)).toBe(true);
    const all = [...sc.decisions, ...sc.journals, ...sc.goals, ...sc.results, ...sc.shared_contexts, ...sc.entity_profiles, ...sc.other];
    expect(all.map((x: any) => x.path)).toContain('_agents/alfa/decisions.md');
  });

  it('types filter restricts groups', async () => {
    const since = '2000-01-01T00:00:00Z';
    const r = await getAgentDelta({ agent: 'alfa', since, types: ['journal'] }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.decisions).toEqual([]);
    expect(sc.journals.length).toBeGreaterThan(0);
  });

  it('include_content=true returns full content', async () => {
    const since = '2000-01-01T00:00:00Z';
    const r = await getAgentDelta({ agent: 'alfa', since, include_content: true }, ctx);
    const sc = r.structuredContent as any;
    const any1 = [...sc.decisions, ...sc.journals, ...sc.other][0];
    expect(typeof any1.content).toBe('string');
  });
});


describe('upsert_shared_context', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      for (let d = path.dirname(p); d !== FIXTURE && fs.existsSync(d) && fs.readdirSync(d).length === 0; d = path.dirname(d)) {
        fs.rmdirSync(d);
      }
    }
  });

  it('creates _shared/context/<topic>/<as_agent>/<slug>.md with shared-context type', async () => {
    const r = await upsertSharedContext({ as_agent: 'alfa', topic: 'objecoes', slug: 'entrada-alta', title: 'Objeção: entrada alta', content: '# ...' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_shared/context/objecoes/alfa/entrada-alta.md');
    created.push(path.join(FIXTURE, sc.path));
    const content = fs.readFileSync(created[0], 'utf8');
    expect(content).toMatch(/type: shared-context/);
    expect(content).toMatch(/topic: objecoes/);
    expect(content).toMatch(/title: /);
  });

  it('INVALID input when slug/topic not kebab', async () => {
    const r = await upsertSharedContext({ as_agent: 'alfa', topic: 'Uppercase', slug: 'x', title: 't', content: '#' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('upsert_entity_profile', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const d = path.dirname(p);
      if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    }
  });

  it('creates _agents/<as_agent>/<entity_type>/<slug>.md with entity-profile fields', async () => {
    const r = await upsertEntityProfile({ as_agent: 'alfa', entity_type: 'construtora', entity_name: 'Foo & Cia', content: '# ...' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_agents/alfa/construtora/foo-cia.md');
    created.push(path.join(FIXTURE, sc.path));
    const content = fs.readFileSync(created[0], 'utf8');
    expect(content).toMatch(/type: entity-profile/);
    expect(content).toMatch(/entity_type: construtora/);
    expect(content).toMatch(/entity_name: /);
  });

  it('INVALID input when entity_type has slash', async () => {
    const r = await upsertEntityProfile({ as_agent: 'alfa', entity_type: 'bad/type', entity_name: 'x', content: '#' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('search_by_tag', () => {
  it('returns notes with the tag', async () => {
    const r = await searchByTag({ tag: 'decisions' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.notes.map((n: any) => n.path)).toContain('_agents/alfa/decisions.md');
  });
  it('INVALID_OWNER on unknown owner', async () => {
    const r = await searchByTag({ tag: 'x', owner: 'zzz' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_OWNER');
  });
});

// ─── search_by_type ──────────────────────────────────────────────────────────

describe('search_by_type', () => {
  it('returns notes of the type', async () => {
    const r = await searchByType({ type: 'agent-profile' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.notes.length).toBeGreaterThanOrEqual(2);
    expect(sc.notes.every((n: any) => n.type === 'agent-profile')).toBe(true);
  });
});

// ─── get_backlinks ───────────────────────────────────────────────────────────

describe('get_backlinks', () => {
  it('returns an array (may be empty)', async () => {
    const r = await getBacklinks({ note_name: 'README' }, ctx);
    const sc = r.structuredContent as any;
    expect(Array.isArray(sc.notes)).toBe(true);
  });
});

describe('workflows enqueue commit jobs', () => {
  it('upsert_lead_timeline enqueues', async () => {
    const queue = new CommitQueue();
    const lock = new ResolutionLock();
    const ctx2: any = { ...ctx, queue, lock };
    const r = await upsertLeadTimeline({
      as_agent: 'alfa',
      lead_name: 'Joao Silva Enq Test',
      resumo: 'novo lead',
    }, ctx2);
    expect(r.isError).toBeUndefined();
    expect(queue.size()).toBe(1);
    const job = queue.shift()!;
    expect(job.tool).toBe('upsert_lead_timeline');
    expect(job.path).toContain('_agents/alfa/lead/joao-silva-enq-test.md');
  });
});
