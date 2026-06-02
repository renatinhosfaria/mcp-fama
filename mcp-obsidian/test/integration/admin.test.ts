import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { bootstrapAgent, deletePath } from '../../src/tools/admin.js';
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';

function setupVault(): { tmp: string; ctx: any } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-'));
  execSync('git init -q -b main', { cwd: tmp });
  execSync('git config user.email "t@t"', { cwd: tmp });
  execSync('git config user.name "t"', { cwd: tmp });
  fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '_agents'), { recursive: true });
  const agentsMd = `---
type: agents-map
owner: renato
created: '2026-04-14'
updated: '2026-04-14'
tags: []
---
# AGENTS

\`\`\`
_agents/ceo/**                   => ceo
_shared/context/AGENTS.md        => renato
_hubs/**                         => renato
_runbooks/**                     => renato
_projects/**                     => renato
_journal/**                      => renato
_shared/context/**               => renato
_agents/README.md                => renato
\`\`\`
`;
  fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), agentsMd);
  const readme = `---
type: moc
owner: renato
created: '2026-04-14'
updated: '2026-04-14'
tags: []
---
# _agents

## Paperclip (diretoria)

- [[ceo/README|ceo]]

## OpenClaw (operacional)

- [[reno/README|reno]]
`;
  fs.writeFileSync(path.join(tmp, '_agents/README.md'), readme);
  return { tmp, ctx: null };
}

describe('bootstrap_agent', () => {
  let tmp: string; let ctx: any;
  beforeEach(async () => {
    const s = setupVault();
    tmp = s.tmp;
    const index = new VaultIndex(tmp); await index.build();
    ctx = { index, vaultRoot: tmp };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('creates v1 territory files and never creates legacy _agents stubs', async () => {
    const agentsBefore = fs.readFileSync(path.join(tmp, '_shared/context/AGENTS.md'), 'utf8');
    const readmeBefore = fs.readFileSync(path.join(tmp, '_agents/README.md'), 'utf8');

    const r = await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);

    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.files_created).toEqual(expect.arrayContaining([
      '_hubs/cxo-hub.md',
      '_journal/cxo/README.md',
      '_projects/cxo/README.md',
      '_shared/context/cxo/README.md',
      '_runbooks/cxo-vault-operacao.md',
    ]));
    expect(sc.patterns_added).toEqual(expect.arrayContaining([
      '_hubs/cxo-hub.md               => cxo',
      '_journal/cxo/**                => cxo',
      '_projects/cxo/**               => cxo',
      '_shared/context/cxo/**         => cxo',
      '_runbooks/cxo-*.md             => cxo',
    ]));
    expect(fs.existsSync(path.join(tmp, '_agents/cxo/profile.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '_agents/cxo/decisions.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '_agents/cxo/README.md'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, '_shared/context/AGENTS.md'), 'utf8')).not.toBe(agentsBefore);
    expect(fs.readFileSync(path.join(tmp, '_agents/README.md'), 'utf8')).toBe(readmeBefore);
  });

  it('rejects invalid slug', async () => {
    const r = await bootstrapAgent({ name: 'Bad-Name', platform: 'paperclip' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });

  it('rejects reserved names', async () => {
    const r = await bootstrapAgent({ name: 'renato', platform: 'paperclip' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_OWNER');
  });

  it('does not overwrite existing legacy files while creating v1 territory', async () => {
    fs.mkdirSync(path.join(tmp, '_agents/cxo'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_agents/cxo/profile.md'), 'CUSTOM CONTENT');
    const r = await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).files_created).toContain('_hubs/cxo-hub.md');
    const profile = fs.readFileSync(path.join(tmp, '_agents/cxo/profile.md'), 'utf8');
    expect(profile).toBe('CUSTOM CONTENT');
  });

  it('profile updates write v1 profile context and append_decision remains deprecated', async () => {
    const { appendDecision, updateAgentProfile } = await import('../../src/tools/workflows.js');
    await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);
    fs.mkdirSync(path.join(tmp, '_agents/cxo'), { recursive: true });
    const decisionsPath = path.join(tmp, '_agents/cxo/decisions.md');
    fs.writeFileSync(decisionsPath, 'CUSTOM DECISIONS');
    const decisionsBefore = fs.readFileSync(decisionsPath, 'utf8');
    const d = await appendDecision({ agent: 'cxo', title: 'primeira', rationale: 'teste' }, ctx);
    expect((d.structuredContent as any).error.code).toBe('DEPRECATED_TOOL');
    expect(fs.readFileSync(decisionsPath, 'utf8')).toBe(decisionsBefore);
    const p = await updateAgentProfile({ agent: 'cxo', content: '# novo profile' }, ctx);
    expect(p.isError).toBeUndefined();
    expect((p.structuredContent as any).path).toBe('_shared/context/cxo/profile.md');
    expect(fs.readFileSync(path.join(tmp, '_shared/context/cxo/profile.md'), 'utf8')).toContain('# novo profile');
  });
});

describe('delete_path', () => {
  let tmp: string; let ctx: any;

  beforeEach(async () => {
    const s = setupVault();
    tmp = s.tmp;
    fs.mkdirSync(path.join(tmp, '_agents/alfa'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_agents/alfa/legacy.md'), 'legacy');
    const index = new VaultIndex(tmp); await index.build();
    ctx = { index, vaultRoot: tmp };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('blocks generic deletion in _agents even for vault_admin', async () => {
    const r = await deletePath({
      path: '_agents/alfa/legacy.md',
      as_agent: 'vault_admin',
      reason: 'legacy cleanup',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
    expect(fs.existsSync(path.join(tmp, '_agents/alfa/legacy.md'))).toBe(true);
  });
});

describe('admin enqueues commit jobs', () => {
  it('bootstrapAgent enqueues for each created file', async () => {
    const { tmp } = setupVault();
    const queue = new CommitQueue();
    const lock = new ResolutionLock();
    const idx = new VaultIndex(tmp); await idx.build();
    const ctx = { index: idx, vaultRoot: tmp, queue, lock };
    const r = await bootstrapAgent({ name: 'novobot', platform: 'paperclip' }, ctx as any);
    expect(r.isError).toBeUndefined();
    expect(queue.size()).toBeGreaterThanOrEqual(6);
    expect(fs.existsSync(path.join(tmp, '_agents/novobot/profile.md'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
