// test/integration/crud.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { readNote, writeNote, appendToNote, deleteNote, listFolder, searchContent, getNoteMetadata, statVault } from '../../src/tools/crud.js';
import { searchByTag, searchByType } from '../../src/tools/workflows.js';
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';
import { config } from '../../src/config.js';

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
  const targetRel = '_shared/context/task3/alfa/notes/del.md';
  const target = path.join(FIXTURE, targetRel);
  const dir = path.dirname(target);
  afterEach(() => { if (fs.existsSync(target)) fs.unlinkSync(target); });

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
    await ctx.index.updateAfterWrite(targetRel);
    const r = await deleteNote({ path: targetRel, as_agent: 'alfa', reason: 'cleanup' }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).deleted).toBe(true);
    expect((r.structuredContent as any).reason).toBe('cleanup');
    expect(fs.existsSync(target)).toBe(false);
    expect(ctx.index.get(targetRel)).toBeUndefined();
  });

  it('OWNERSHIP_VIOLATION when as_agent != owner', async () => {
    const r = await deleteNote({ path: '_shared/context/task3/alfa/notes/owned.md', as_agent: 'beta', reason: 'x' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });

  it('reason required', async () => {
    const r = await deleteNote({ path: '_agents/alfa/decisions.md', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('append_to_note', () => {
  const tempRel = '_shared/context/task3/alfa/notes/app.md';
  const tempPath = path.join(FIXTURE, tempRel);
  afterEach(async () => {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
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
    await ctx.index.updateAfterWrite(tempRel);
    const r = await appendToNote({ path: tempRel, content: '\nappended', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.readFileSync(tempPath, 'utf8')).toContain('appended');
  });

  it('IMMUTABLE_TARGET on decisions.md', async () => {
    const r = await appendToNote({ path: '_decisions/alfa/decisions.md', content: 'x', as_agent: 'alfa' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('IMMUTABLE_TARGET');
  });

  it('JOURNAL_IMMUTABLE on v1 journal event paths', async () => {
    const r = await appendToNote({ path: '_journal/alfa/2026-05-11-x.md', content: 'x', as_agent: 'alfa' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('JOURNAL_IMMUTABLE');
  });
});

describe('write_note', () => {
  const createdFiles = [
    '_shared/context/task3/alfa/notes/x.md',
    '_shared/context/task3/alfa/notes/v1-entity.md',
    '_shared/context/task3/beta/notes/v1-entity.md',
    '_random/dir/v1-entity.md',
  ];

  afterEach(async () => {
    for (const rel of createdFiles) {
      const full = path.join(FIXTURE, rel);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
  });

  it('creates new note with valid frontmatter and ownership', async () => {
    const args = {
      path: '_shared/context/task3/alfa/notes/x.md',
      content: '# new',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    };
    const r = await writeNote(args, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(path.join(FIXTURE, '_shared/context/task3/alfa/notes/x.md'))).toBe(true);
  });

  it('OWNERSHIP_VIOLATION when as_agent !== owner', async () => {
    const r = await writeNote({
      path: '_shared/context/task3/alfa/notes/y.md',
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

  it('rejects new note with uppercase and underscore filename', async () => {
    const r = await writeNote({
      path: '_shared/context/task3/alfa/notes/Bad_Name.md',
      content: '#',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });

  it('IMMUTABLE_TARGET on decisions.md', async () => {
    const r = await writeNote({
      path: '_decisions/alfa/decisions.md',
      content: 'x',
      frontmatter: { type: 'agent-decisions', owner: 'alfa', created: '2026-04-01', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('IMMUTABLE_TARGET');
  });

  it('JOURNAL_IMMUTABLE on v1 journal event paths', async () => {
    const r = await writeNote({
      path: '_journal/alfa/2026-05-11-x.md',
      content: 'overwritten',
      frontmatter: { schema_version: 1, type: 'journal', status: 'active', source: 'agent-generated', author_agent: 'alfa', event_date: '2026-05-11', title: 'x', created: '2026-05-11', updated: '2026-05-11', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('JOURNAL_IMMUTABLE');
  });

  it('rejects Schema v1 notes outside their routed destination', async () => {
    const rel = '_shared/context/task3/alfa/notes/v1-entity.md';
    const r = await writeNote({
      path: rel,
      content: '# V1 entity in wrong folder',
      frontmatter: {
        schema_version: 1,
        type: 'entity',
        status: 'active',
        source: 'agent-generated',
        author_agent: 'alfa',
        created: '2026-05-11',
        updated: '2026-05-11',
        tags: [],
        name: 'Wrong Folder',
        entity_type: 'person',
      },
      as_agent: 'alfa',
    }, ctx);

    expect((r.structuredContent as any).error.code).toBe('ROUTING_VIOLATION');
    expect(fs.existsSync(path.join(FIXTURE, rel))).toBe(false);
  });

  it('rejects Schema v1 routing before unmapped path checks', async () => {
    const rel = '_random/dir/v1-entity.md';
    const r = await writeNote({
      path: rel,
      content: '# V1 entity in unmapped wrong folder',
      frontmatter: {
        schema_version: 1,
        type: 'entity',
        status: 'active',
        source: 'agent-generated',
        author_agent: 'alfa',
        created: '2026-05-11',
        updated: '2026-05-11',
        tags: [],
        name: 'Wrong Folder',
        entity_type: 'person',
      },
      as_agent: 'alfa',
    }, ctx);

    expect((r.structuredContent as any).error.code).toBe('ROUTING_VIOLATION');
    expect(fs.existsSync(path.join(FIXTURE, rel))).toBe(false);
  });

  it('rejects Schema v1 routing before ownership checks', async () => {
    const rel = '_shared/context/task3/beta/notes/v1-entity.md';
    const r = await writeNote({
      path: rel,
      content: '# V1 entity in beta wrong folder',
      frontmatter: {
        schema_version: 1,
        type: 'entity',
        status: 'active',
        source: 'agent-generated',
        author_agent: 'alfa',
        created: '2026-05-11',
        updated: '2026-05-11',
        tags: [],
        name: 'Wrong Folder',
        entity_type: 'person',
      },
      as_agent: 'alfa',
    }, ctx);

    expect((r.structuredContent as any).error.code).toBe('ROUTING_VIOLATION');
    expect(fs.existsSync(path.join(FIXTURE, rel))).toBe(false);
  });
});

describe('write_note with qualified ownership scopes', () => {
  let tmp: string;
  let localCtx: { index: VaultIndex; vaultRoot: string };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-qualified-owner-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      "```\n_journal/alfa/profile.md => alfa (primary) | vault-steward (structural-only)\n```",
    );
    const index = new VaultIndex(tmp);
    await index.build();
    localCtx = { index, vaultRoot: tmp };
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('allows vault-steward to write a path where it is a qualified secondary actor', async () => {
    const r = await writeNote({
      path: '_journal/alfa/profile.md',
      content: '# Profile\n',
      frontmatter: { type: 'agent-profile', owner: 'alfa', created: '2026-04-30', updated: '2026-04-30', tags: [] },
      as_agent: 'vault-steward',
    }, localCtx);

    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, '_journal/alfa/profile.md'))).toBe(true);
  });
});

describe('write_note filename validation on create only', () => {
  let tmp: string;
  let localCtx: { index: VaultIndex; vaultRoot: string };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-existing-filename-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), "```\n_meta/** => alfa\n```");
    fs.writeFileSync(path.join(tmp, '_meta/README.md'), `---
type: agent-readme
owner: alfa
created: 2026-04-30
updated: 2026-04-30
tags: []
---
# Existing`);
    const index = new VaultIndex(tmp);
    await index.build();
    localCtx = { index, vaultRoot: tmp };
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('allows updating existing uppercase canonical files', async () => {
    const r = await writeNote({
      path: '_meta/README.md',
      content: '# Updated',
      frontmatter: { type: 'agent-readme', owner: 'alfa', created: '2026-04-30', updated: '2026-04-30', tags: [] },
      as_agent: 'alfa',
    }, localCtx);

    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).created).toBe(false);
    expect(fs.readFileSync(path.join(tmp, '_meta/README.md'), 'utf8')).toContain('# Updated');
  });
});

describe('vault_admin ownership bypass', () => {
  const adminManaged = '_shared/context/task3/alfa/notes/admin-managed.md';
  const adminManagedAbs = path.join(FIXTURE, adminManaged);
  const alfaDecisions = '_decisions/alfa/decisions.md';
  const unmappedRel = '_archive/admin-test.md';
  const unmappedAbs = path.join(FIXTURE, unmappedRel);

  afterEach(() => {
    for (const p of [adminManagedAbs, unmappedAbs]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('write_note allows vault_admin to write in another owner zone', async () => {
    const r = await writeNote({
      path: adminManaged,
      content: '# admin-managed note in alfa-owned zone',
      frontmatter: { type: 'agent-readme', owner: 'alfa', created: '2026-04-21', updated: '2026-04-21', tags: [] },
      as_agent: 'vault_admin',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(adminManagedAbs)).toBe(true);
  });

  it('write_note allows vault_admin to write to an unmapped path', async () => {
    const r = await writeNote({
      path: unmappedRel,
      content: '# archive',
      frontmatter: { type: 'agent-readme', owner: 'vault_admin', created: '2026-04-21', updated: '2026-04-21', tags: [] },
      as_agent: 'vault_admin',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(unmappedAbs)).toBe(true);
  });

  it('append_to_note allows vault_admin to append in another owner zone', async () => {
    fs.mkdirSync(path.dirname(adminManagedAbs), { recursive: true });
    fs.writeFileSync(adminManagedAbs, `---
type: agent-readme
owner: alfa
created: 2026-04-21
updated: 2026-04-21
tags: []
---
# base`);
    await ctx.index.updateAfterWrite(adminManaged);
    const r = await appendToNote({ path: adminManaged, content: '\nadmin appended', as_agent: 'vault_admin' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.readFileSync(adminManagedAbs, 'utf8')).toContain('admin appended');
  });

  it('delete_note allows vault_admin to delete in another owner zone', async () => {
    fs.mkdirSync(path.dirname(adminManagedAbs), { recursive: true });
    fs.writeFileSync(adminManagedAbs, `---
type: agent-readme
owner: alfa
created: 2026-04-21
updated: 2026-04-21
tags: []
---
x`);
    await ctx.index.updateAfterWrite(adminManaged);
    const r = await deleteNote({ path: adminManaged, as_agent: 'vault_admin', reason: 'admin cleanup' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(adminManagedAbs)).toBe(false);
  });

  it('write_note still blocks IMMUTABLE_TARGET on decisions.md even for vault_admin', async () => {
    const r = await writeNote({
      path: alfaDecisions,
      content: 'x',
      frontmatter: { type: 'agent-decisions', owner: 'alfa', created: '2026-04-01', updated: '2026-04-21', tags: [] },
      as_agent: 'vault_admin',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('IMMUTABLE_TARGET');
  });

  it('append_to_note still blocks IMMUTABLE_TARGET on decisions.md even for vault_admin', async () => {
    const r = await appendToNote({ path: alfaDecisions, content: 'x', as_agent: 'vault_admin' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('IMMUTABLE_TARGET');
  });

  it('write_note blocks removed legacy journal paths before immutable checks even for vault_admin', async () => {
    const r = await writeNote({
      path: '_agents/alfa/journal/2026-04-15-titulo.md',
      content: 'overwritten',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-15', updated: '2026-04-21', tags: [], title: 'titulo' },
      as_agent: 'vault_admin',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
  });

  it('append_to_note blocks removed legacy journal paths before immutable checks even for vault_admin', async () => {
    const r = await appendToNote({
      path: '_agents/alfa/journal/2026-04-15-titulo.md',
      content: 'extra',
      as_agent: 'vault_admin',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
  });

  it('write_note blocks removed _agents namespace even for vault_admin', async () => {
    const r = await writeNote({
      path: '_agents/alfa/new.md',
      content: '# legacy',
      frontmatter: { type: 'agent-readme', owner: 'alfa', created: '2026-04-21', updated: '2026-04-21', tags: [] },
      as_agent: 'vault_admin',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
  });

  it('write_note blocks dot-normalized removed _agents namespace even for vault_admin', async () => {
    const r = await writeNote({
      path: './_agents/alfa/new.md',
      content: '# legacy',
      frontmatter: { type: 'agent-readme', owner: 'alfa', created: '2026-04-21', updated: '2026-04-21', tags: [] },
      as_agent: 'vault_admin',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
  });

  it('append_to_note blocks removed _agents namespace even for vault_admin', async () => {
    const r = await appendToNote({ path: '_agents/alfa/new.md', content: 'x', as_agent: 'vault_admin' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
  });

  it('delete_note blocks removed _agents namespace even for vault_admin', async () => {
    const r = await deleteNote({ path: '_agents/alfa/new.md', as_agent: 'vault_admin', reason: 'legacy namespace' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
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

describe('search min_trust filtering', () => {
  let tmp: string;
  let localCtx: { index: VaultIndex; vaultRoot: string };
  let oldHumanVerifiers: string[];

  beforeEach(async () => {
    oldHumanVerifiers = [...config.humanVerifiers];
    config.humanVerifiers = ['Renato Faria'];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-min-trust-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '_agents/alfa'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
    fs.writeFileSync(path.join(tmp, '_agents/alfa/agent-verified.md'), `---
type: journal
owner: alfa
source: agent-generated
created: 2026-04-01
updated: 2026-04-01
tags: [trust]
verified_by: reno
---
trustword agent verified note`);
    fs.writeFileSync(path.join(tmp, '_agents/alfa/human-verified.md'), `---
type: journal
owner: alfa
source: agent-generated
created: 2026-04-01
updated: 2026-04-01
tags: [trust]
verified_by: Renato Faria
---
trustword human verified note`);
    fs.writeFileSync(path.join(tmp, '_agents/alfa/unverified.md'), `---
type: journal
owner: alfa
source: agent-generated
created: 2026-04-01
updated: 2026-04-01
tags: [trust]
---
trustword unverified note`);
    const index = new VaultIndex(tmp);
    await index.build();
    localCtx = { index, vaultRoot: tmp };
  });

  afterEach(() => {
    config.humanVerifiers = oldHumanVerifiers;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.skipIf(!rgAvailable)('search_content min_trust=verified keeps agent and human verified notes', async () => {
    const r = await searchContent({ query: 'trustword', min_trust: 'verified' }, localCtx);
    const matches = (r.structuredContent as any).matches.sort((a: any, b: any) => a.path.localeCompare(b.path));
    expect(matches.map((m: any) => [m.path, m.trust_level, m.verified_mode, m.verified])).toEqual([
      ['_agents/alfa/agent-verified.md', 'agent_verified', 'agent', true],
      ['_agents/alfa/human-verified.md', 'human_verified', 'human', true],
    ]);
  });

  it.skipIf(!rgAvailable)('search_content min_trust=human keeps only human trusted notes', async () => {
    const r = await searchContent({ query: 'trustword', min_trust: 'human' }, localCtx);
    const matches = (r.structuredContent as any).matches;
    expect(matches.map((m: any) => [m.path, m.trust_level, m.verified_mode])).toEqual([
      ['_agents/alfa/human-verified.md', 'human_verified', 'human'],
    ]);
  });

  it.skipIf(!rgAvailable)('search_content default min_trust returns all with verified flag', async () => {
    const r = await searchContent({ query: 'trustword' }, localCtx);
    const matches = (r.structuredContent as any).matches.sort((a: any, b: any) => a.path.localeCompare(b.path));
    expect(matches.map((m: any) => [m.path, m.trust_level, m.verified_mode, m.verified])).toEqual([
      ['_agents/alfa/agent-verified.md', 'agent_verified', 'agent', true],
      ['_agents/alfa/human-verified.md', 'human_verified', 'human', true],
      ['_agents/alfa/unverified.md', 'unverified_agent', 'none', false],
    ]);
  });

  it('read_note min_trust=human rejects unverified agent notes', async () => {
    const r = await readNote({ path: '_agents/alfa/unverified.md', min_trust: 'human' }, localCtx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('TRUST_POLICY_VIOLATION');
  });

  it('read_note returns trust metadata when min_trust passes', async () => {
    const r = await readNote({ path: '_agents/alfa/agent-verified.md', min_trust: 'verified' }, localCtx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).trust).toMatchObject({
      trust_level: 'agent_verified',
      verified_mode: 'agent',
      verified: true,
    });
  });

  it('search_by_tag min_trust=human keeps only human trusted notes', async () => {
    const r = await searchByTag({ tag: 'trust', min_trust: 'human' }, localCtx);
    const notes = (r.structuredContent as any).notes;
    expect(notes.map((n: any) => [n.path, n.trust_level, n.verified_mode, n.verified])).toEqual([
      ['_agents/alfa/human-verified.md', 'human_verified', 'human', true],
    ]);
  });

  it('search_by_tag min_trust=verified keeps agent and human verified notes', async () => {
    const r = await searchByTag({ tag: 'trust', min_trust: 'verified' }, localCtx);
    const notes = (r.structuredContent as any).notes.sort((a: any, b: any) => a.path.localeCompare(b.path));
    expect(notes.map((n: any) => [n.path, n.trust_level, n.verified_mode, n.verified])).toEqual([
      ['_agents/alfa/agent-verified.md', 'agent_verified', 'agent', true],
      ['_agents/alfa/human-verified.md', 'human_verified', 'human', true],
    ]);
  });

  it('search_by_type default min_trust returns all with verified flag', async () => {
    const r = await searchByType({ type: 'journal' }, localCtx);
    const notes = (r.structuredContent as any).notes.sort((a: any, b: any) => a.path.localeCompare(b.path));
    expect(notes.map((n: any) => [n.path, n.trust_level, n.verified_mode, n.verified])).toEqual([
      ['_agents/alfa/agent-verified.md', 'agent_verified', 'agent', true],
      ['_agents/alfa/human-verified.md', 'human_verified', 'human', true],
      ['_agents/alfa/unverified.md', 'unverified_agent', 'none', false],
    ]);
  });
});

// ─── H7: get_note_metadata + stat_vault ─────────────────────────────────────

describe('get_note_metadata', () => {
  it('returns frontmatter + wikilinks + backlinks + bytes', async () => {
    const r = await getNoteMetadata({ path: '_agents/alfa/README.md' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.frontmatter.type).toBe('agent-readme');
    expect(Array.isArray(sc.wikilinks)).toBe(true);
    expect(Array.isArray(sc.backlinks)).toBe(true);
    expect(typeof sc.bytes).toBe('number');
  });
  it('NOTE_NOT_FOUND on missing', async () => {
    const r = await getNoteMetadata({ path: '_agents/alfa/missing.md' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('NOTE_NOT_FOUND');
  });
});

describe('stat_vault', () => {
  it('returns counts', async () => {
    const r = await statVault({}, ctx);
    const sc = r.structuredContent as any;
    expect(sc.total_notes).toBeGreaterThan(0);
    expect(typeof sc.by_type).toBe('object');
    expect(typeof sc.by_agent).toBe('object');
    expect(typeof sc.index_age_ms).toBe('number');
  });
});

describe('crud writes enqueue commit jobs', () => {
  it('writeNote enqueues after successful write', async () => {
    const queue = new CommitQueue();
    const lock = new ResolutionLock();
    const idx = new VaultIndex(FIXTURE);
    await idx.build();
    const ctx2 = { index: idx, vaultRoot: FIXTURE, queue, lock };
    const r = await writeNote({
      path: '_shared/context/task3/alfa/notes/enq.md',
      content: 'x',
      frontmatter: { type: 'agent-readme', owner: 'alfa', created: '2026-04-01', updated: '2026-04-01', tags: [] },
      as_agent: 'alfa',
    }, ctx2 as any);
    expect(r.isError).toBeUndefined();
    expect(queue.size()).toBe(1);
    const job = queue.shift()!;
    expect(job.path).toBe('_shared/context/task3/alfa/notes/enq.md');
    expect(job.tool).toBe('write_note');
    expect(job.message).toContain('write_note');
    const enqueuedPath = path.join(FIXTURE, '_shared/context/task3/alfa/notes/enq.md');
    if (fs.existsSync(enqueuedPath)) fs.unlinkSync(enqueuedPath);
  });
});
