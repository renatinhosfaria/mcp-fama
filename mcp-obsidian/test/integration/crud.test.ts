// test/integration/crud.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { readNote, writeNote, appendToNote, deleteNote, listFolder, searchContent } from '../../src/tools/crud.js';

let rgAvailable = true;
try { execSync('rg --version', { stdio: 'ignore' }); } catch { rgAvailable = false; }

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

describe('delete_note', () => {
  const target = path.join(FIXTURE, '_agents/alfa/notes/del.md');
  const dir = path.dirname(target);
  afterEach(() => { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('deletes file with reason and removes from index', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, `---
type: agent-readme
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
x`);
    await ctx.index.updateAfterWrite('_agents/alfa/notes/del.md');
    const r = await deleteNote({ path: '_agents/alfa/notes/del.md', as_agent: 'alfa', reason: 'cleanup' }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).deleted).toBe(true);
    expect((r.structuredContent as any).reason).toBe('cleanup');
    expect(fs.existsSync(target)).toBe(false);
    expect(ctx.index.get('_agents/alfa/notes/del.md')).toBeUndefined();
  });

  it('OWNERSHIP_VIOLATION when as_agent != owner', async () => {
    const r = await deleteNote({ path: '_agents/alfa/decisions.md', as_agent: 'beta', reason: 'x' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });

  it('reason required', async () => {
    const r = await deleteNote({ path: '_agents/alfa/decisions.md', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('append_to_note', () => {
  const tempPath = path.join(FIXTURE, '_agents/alfa/notes/app.md');
  afterEach(async () => {
    const dir = path.dirname(tempPath);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  it('appends content to an existing non-immutable note', async () => {
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    fs.writeFileSync(tempPath, `---
type: agent-readme
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
# x`);
    await ctx.index.updateAfterWrite('_agents/alfa/notes/app.md');
    const r = await appendToNote({ path: '_agents/alfa/notes/app.md', content: '\nappended', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.readFileSync(tempPath, 'utf8')).toContain('appended');
  });

  it('IMMUTABLE_TARGET on decisions.md', async () => {
    const r = await appendToNote({ path: '_agents/alfa/decisions.md', content: 'x', as_agent: 'alfa' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('IMMUTABLE_TARGET');
  });
});

describe('write_note', () => {
  afterEach(async () => {
    const dir = path.join(FIXTURE, '_agents/alfa/notes');
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  it('creates new note with valid frontmatter and ownership', async () => {
    const args = {
      path: '_agents/alfa/notes/x.md',
      content: '# new',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    };
    const r = await writeNote(args, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(path.join(FIXTURE, '_agents/alfa/notes/x.md'))).toBe(true);
  });

  it('OWNERSHIP_VIOLATION when as_agent !== owner', async () => {
    const r = await writeNote({
      path: '_agents/alfa/notes/y.md',
      content: '#',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'beta',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });

  it('UNMAPPED_PATH when path is not in ownership map', async () => {
    const r = await writeNote({
      path: '_random/dir/z.md',
      content: '#',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('UNMAPPED_PATH');
  });

  it('INVALID_FILENAME on uppercase filename', async () => {
    const r = await writeNote({
      path: '_agents/alfa/notes/Bad.md',
      content: '#',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });

  it('IMMUTABLE_TARGET on decisions.md', async () => {
    const r = await writeNote({
      path: '_agents/alfa/decisions.md',
      content: 'x',
      frontmatter: { type: 'agent-decisions', owner: 'alfa', created: '2026-04-01', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('IMMUTABLE_TARGET');
  });
});

describe('read_note', () => {
  it('returns frontmatter, content, and metadata', async () => {
    const r = await readNote({ path: '_agents/alfa/decisions.md' }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).frontmatter.type).toBe('agent-decisions');
    expect((r.structuredContent as any).path).toBe('_agents/alfa/decisions.md');
    expect((r.structuredContent as any).content).toContain('first decision');
    expect((r.structuredContent as any).bytes).toBeGreaterThan(0);
  });
  it('throws NOTE_NOT_FOUND for missing file', async () => {
    const r = await readNote({ path: '_agents/missing.md' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('NOTE_NOT_FOUND');
  });
  it('throws VAULT_IO_ERROR on path traversal', async () => {
    const r = await readNote({ path: '../etc/passwd' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('VAULT_IO_ERROR');
  });
});

// ─── H5: list_folder ────────────────────────────────────────────────────────

describe('list_folder', () => {
  it('lists notes under a folder', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true }, ctx);
    const items = (r.structuredContent as any).items;
    expect(items.map((i: any) => i.path)).toContain('_agents/alfa/decisions.md');
    expect(items.every((i: any) => i.path.startsWith('_agents/alfa/'))).toBe(true);
  });

  it('owner filter accepts string or array', async () => {
    const r1 = await listFolder({ path: '_agents', recursive: true, owner: 'alfa' }, ctx);
    expect((r1.structuredContent as any).items.every((i: any) => i.owner === 'alfa')).toBe(true);

    const r2 = await listFolder({ path: '_agents', recursive: true, owner: ['alfa', 'beta'] }, ctx);
    const owners = new Set((r2.structuredContent as any).items.map((i: any) => i.owner));
    expect([...owners].sort()).toEqual(['alfa', 'beta']);
  });

  it('INVALID_OWNER on unknown agent', async () => {
    const r = await listFolder({ path: '_agents', recursive: true, owner: 'gamma' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_OWNER');
  });

  it('paginates via cursor + limit', async () => {
    const r1 = await listFolder({ path: '_agents', recursive: true, limit: 2 }, ctx);
    const items1 = (r1.structuredContent as any).items;
    const cursor = (r1.structuredContent as any).next_cursor;
    expect(items1.length).toBe(2);
    expect(typeof cursor).toBe('string');
    const r2 = await listFolder({ path: '_agents', recursive: true, limit: 2, cursor }, ctx);
    const items2 = (r2.structuredContent as any).items;
    expect(items2[0].path).not.toBe(items1[0].path);
  });
});

// ─── H6: search_content ─────────────────────────────────────────────────────

describe.skipIf(!rgAvailable)('search_content', () => {
  it('finds literal occurrences', async () => {
    const r = await searchContent({ query: 'first decision' }, ctx);
    const matches = (r.structuredContent as any).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].path).toBe('_agents/alfa/decisions.md');
    expect(matches[0].line).toBeGreaterThan(0);
  });
});
