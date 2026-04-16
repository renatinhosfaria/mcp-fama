import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { GitOps } from '../../src/vault/git.js';

describe('GitOps', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-git-'));
    execSync('git init -q -b main', { cwd: tmp });
    execSync('git config user.email "t@t"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# init');
    execSync('git add .', { cwd: tmp });
    execSync('git commit -q -m init', { cwd: tmp });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('status reports clean repo', async () => {
    const g = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.status();
    expect(r.modified).toEqual([]);
    expect(r.untracked).toEqual([]);
  });

  it('status reports modifications', async () => {
    fs.writeFileSync(path.join(tmp, 'new.md'), 'x');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# changed');
    const g = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.status();
    expect(r.untracked).toContain('new.md');
    expect(r.modified).toContain('README.md');
  });

  it('commitAndPush creates commit with [mcp-obsidian] prefix (no remote → pushed=false)', async () => {
    fs.writeFileSync(path.join(tmp, 'x.md'), 'x');
    const g = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.commitAndPush('test commit');
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.branch).toBe('main');
    expect(r.pushed).toBe(false);
    const log = execSync('git log --oneline -1', { cwd: tmp, encoding: 'utf8' });
    expect(log).toContain('[mcp-obsidian] test commit');
  });

  it('commitAndPush no-op when nothing to commit', async () => {
    const g = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.commitAndPush('noop');
    expect(r.sha).toBe('');
    expect(r.pushed).toBe(false);
  });

  it('head returns current HEAD sha', async () => {
    const g = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp-obsidian', 'mcp@fama.local');
    const h = await g.head();
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });
});
