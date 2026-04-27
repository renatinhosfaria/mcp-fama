import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { bootstrapAgent } from '../../src/tools/admin.js';
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

  it('creates patterns, stubs, and updates README for a new paperclip agent', async () => {
    const r = await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.name).toBe('cxo');
    expect(sc.patterns_added.length).toBe(2);
    expect(sc.files_created).toEqual([
      '_agents/cxo/profile.md',
      '_agents/cxo/decisions.md',
      '_agents/cxo/README.md',
    ]);
    expect(sc.readme_updated).toBe(true);

    const agentsMd = fs.readFileSync(path.join(tmp, '_shared/context/AGENTS.md'), 'utf8');
    expect(agentsMd).toMatch(/_agents\/cxo\/\*\*\s+=> cxo/);
    expect(agentsMd).toMatch(/_shared\/context\/\*\/cxo\/\*\*\s+=> cxo/);

    const profile = fs.readFileSync(path.join(tmp, '_agents/cxo/profile.md'), 'utf8');
    expect(profile).toMatch(/type: agent-profile/);
    expect(profile).toMatch(/owner: cxo/);

    const readme = fs.readFileSync(path.join(tmp, '_agents/README.md'), 'utf8');
    expect(readme).toMatch(/- \[\[cxo\/README\|cxo\]\]/);
    const lines = readme.split('\n');
    const papIdx = lines.indexOf('## Paperclip (diretoria)');
    const opIdx  = lines.indexOf('## OpenClaw (operacional)');
    const cxoIdx = lines.findIndex(l => l.includes('[[cxo/README|cxo]]'));
    expect(cxoIdx).toBeGreaterThan(papIdx);
    expect(cxoIdx).toBeLessThan(opIdx);
  });

  it('adds optional goals/results/financials patterns when requested', async () => {
    await bootstrapAgent({
      name: 'cfoexec2',
      platform: 'openclaw',
      include_shared_goals: true,
      include_shared_results: true,
      include_financials: true,
    }, ctx);
    const agentsMd = fs.readFileSync(path.join(tmp, '_shared/context/AGENTS.md'), 'utf8');
    expect(agentsMd).toMatch(/_shared\/goals\/\*\/cfoexec2\.md/);
    expect(agentsMd).toMatch(/_shared\/results\/\*\/cfoexec2\.md/);
    expect(agentsMd).toMatch(/_shared\/financials\/\*\/cfoexec2\.md/);
  });

  it('is idempotent — running twice adds nothing the second time', async () => {
    await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);
    const r2 = await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);
    const sc = r2.structuredContent as any;
    expect(sc.patterns_added).toEqual([]);
    expect(sc.files_created).toEqual([]);
    expect(sc.readme_updated).toBe(false);
    expect(sc.already_existed).toBe(true);
  });

  it('rejects invalid slug', async () => {
    const r = await bootstrapAgent({ name: 'Bad-Name', platform: 'paperclip' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });

  it('rejects reserved names', async () => {
    const r = await bootstrapAgent({ name: 'renato', platform: 'paperclip' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_OWNER');
  });

  it('places openclaw agent in the right section', async () => {
    await bootstrapAgent({ name: 'novoexec', platform: 'openclaw' }, ctx);
    const readme = fs.readFileSync(path.join(tmp, '_agents/README.md'), 'utf8');
    const lines = readme.split('\n');
    const opIdx = lines.indexOf('## OpenClaw (operacional)');
    const novoIdx = lines.findIndex(l => l.includes('[[novoexec/README|novoexec]]'));
    expect(novoIdx).toBeGreaterThan(opIdx);
  });

  it('does not overwrite existing agent files', async () => {
    fs.mkdirSync(path.join(tmp, '_agents/cxo'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_agents/cxo/profile.md'), 'CUSTOM CONTENT');
    await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);
    const profile = fs.readFileSync(path.join(tmp, '_agents/cxo/profile.md'), 'utf8');
    expect(profile).toBe('CUSTOM CONTENT');
  });

  it('new agent can then use append_decision and update_agent_profile', async () => {
    const { appendDecision, updateAgentProfile } = await import('../../src/tools/workflows.js');
    await bootstrapAgent({ name: 'cxo', platform: 'paperclip' }, ctx);
    const d = await appendDecision({ agent: 'cxo', title: 'primeira', rationale: 'teste' }, ctx);
    expect(d.isError).toBeUndefined();
    const p = await updateAgentProfile({ agent: 'cxo', content: '# novo profile' }, ctx);
    expect(p.isError).toBeUndefined();
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
    // patterns line in AGENTS.md + 3 stub files + README link → at least 4 enqueues
    expect(queue.size()).toBeGreaterThanOrEqual(4);
    const paths = [...queue.pendingPaths()];
    expect(paths.some(p => p.endsWith('AGENTS.md'))).toBe(true);
    expect(paths.some(p => p.includes('_agents/novobot/profile.md'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
