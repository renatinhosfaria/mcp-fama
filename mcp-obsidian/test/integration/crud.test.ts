// test/integration/crud.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { readNote, writeNote, appendToNote, deleteNote } from '../../src/tools/crud.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
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
