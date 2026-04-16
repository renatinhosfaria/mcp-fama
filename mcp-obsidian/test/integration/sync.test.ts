import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { GitOps } from '../../src/vault/git.js';
import { commitAndPush, gitStatus } from '../../src/tools/sync.js';

describe('git tools', () => {
  let tmp: string; let ctx: any;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-'));
    execSync('git init -q -b main', { cwd: tmp });
    execSync('git config user.email "t@t"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => x\n```');
    fs.writeFileSync(path.join(tmp, 'README.md'), '#');
    execSync('git add .', { cwd: tmp });
    execSync('git commit -q -m init', { cwd: tmp });
    const index = new VaultIndex(tmp); await index.build();
    const git = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp-obsidian', 'mcp@fama.local');
    ctx = { index, vaultRoot: tmp, git };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('git_status clean', async () => {
    const r = await gitStatus({}, ctx);
    expect((r.structuredContent as any).modified).toEqual([]);
  });

  it('commit_and_push creates commit with prefix', async () => {
    fs.writeFileSync(path.join(tmp, 'new.md'), 'x');
    const r = await commitAndPush({ message: 'added new' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.sha).toMatch(/^[0-9a-f]{40}$/);
    const log = execSync('git log --oneline -1', { cwd: tmp, encoding: 'utf8' });
    expect(log).toContain('[mcp-obsidian] added new');
  });

  it('VAULT_IO_ERROR if git not configured', async () => {
    const r = await commitAndPush({ message: 'x' }, { ...ctx, git: undefined });
    expect((r.structuredContent as any).error.code).toBe('VAULT_IO_ERROR');
  });
});
