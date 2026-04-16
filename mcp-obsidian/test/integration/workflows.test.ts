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
