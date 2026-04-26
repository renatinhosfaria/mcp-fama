import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
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
    const g = new GitOps(tmp);
    const r = await g.status();
    expect(r.modified).toEqual([]);
    expect(r.untracked).toEqual([]);
  });

  it('status reports modifications', async () => {
    fs.writeFileSync(path.join(tmp, 'new.md'), 'x');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# changed');
    const g = new GitOps(tmp);
    const r = await g.status();
    expect(r.untracked).toContain('new.md');
    expect(r.modified).toContain('README.md');
  });

  it('head returns current HEAD sha', async () => {
    const g = new GitOps(tmp);
    const h = await g.head();
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('GitOps extensions', () => {
  let local: string;
  let bare: string;

  beforeAll(() => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bare-'));
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-local-'));
    execSync('git init -q --bare', { cwd: bare });
    execSync('git init -q -b main', { cwd: local });
    execSync('git config user.email t@t', { cwd: local });
    execSync('git config user.name t', { cwd: local });
    execSync(`git remote add origin "${bare}"`, { cwd: local });
    fs.writeFileSync(path.join(local, 'a.md'), 'hello');
    execSync('git add . && git commit -q -m init && git push -q -u origin main', { cwd: local });
  });

  afterAll(() => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('fetch + isLocalBehind = false when up-to-date', async () => {
    const g = new GitOps(local);
    await g.fetch('origin', 'main');
    expect(await g.isLocalBehind('origin', 'main')).toBe(false);
  });

  it('isLocalBehind = true after a separate clone pushes', async () => {
    const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-other-'));
    execSync(`git clone -q "${bare}" "${otherClone}"`);
    execSync('git config user.email o@o', { cwd: otherClone });
    execSync('git config user.name o', { cwd: otherClone });
    fs.writeFileSync(path.join(otherClone, 'b.md'), 'world');
    execSync('git add . && git commit -q -m other && git push -q origin main', { cwd: otherClone });

    const g = new GitOps(local);
    await g.fetch('origin', 'main');
    expect(await g.isLocalBehind('origin', 'main')).toBe(true);
    const diff = await g.diffNames('HEAD', 'origin/main');
    expect(diff).toContain('b.md');

    fs.rmSync(otherClone, { recursive: true, force: true });
  });

  it('pullRebase applies remote commits cleanly when no local diff', async () => {
    const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-other2-'));
    execSync(`git clone -q "${bare}" "${otherClone}"`);
    execSync('git config user.email o@o', { cwd: otherClone });
    execSync('git config user.name o', { cwd: otherClone });
    fs.writeFileSync(path.join(otherClone, 'pr.md'), 'remote');
    execSync('git add . && git commit -q -m remote && git push -q origin main', { cwd: otherClone });

    const g = new GitOps(local);
    await g.fetch('origin', 'main');
    await g.pullRebase('origin', 'main');
    expect(fs.existsSync(path.join(local, 'pr.md'))).toBe(true);

    fs.rmSync(otherClone, { recursive: true, force: true });
  });

  it('resetHard adopts remote state, discarding local commits', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rh-'));
    execSync(`git clone -q "${bare}" "${tmp}"`);
    execSync('git config user.email t@t', { cwd: tmp });
    execSync('git config user.name t', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'discardable.md'), 'will be lost');
    execSync('git add . && git commit -q -m local-only', { cwd: tmp });

    const g = new GitOps(tmp);
    await g.fetch('origin', 'main');
    await g.resetHard('origin/main');
    expect(fs.existsSync(path.join(tmp, 'discardable.md'))).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
