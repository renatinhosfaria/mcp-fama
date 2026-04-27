import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { GitOps } from '../../src/vault/git.js';
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';
import { SyncWorker, SyncFs } from '../../src/vault/sync-worker.js';

function setup(): { local: string; bare: string; other: string; cleanup: () => void } {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-bare-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-local-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-other-'));
  execSync('git init -q --bare', { cwd: bare });
  execSync('git init -q -b main', { cwd: local });
  execSync('git config user.email mcp@t', { cwd: local });
  execSync('git config user.name mcp', { cwd: local });
  execSync('git config commit.gpgsign false', { cwd: local });
  execSync(`git remote add origin "${bare}"`, { cwd: local });
  fs.mkdirSync(path.join(local, '_shared/context'), { recursive: true });
  fs.writeFileSync(path.join(local, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
  execSync('git add . && git commit -q -m init && git push -q -u origin main', { cwd: local });

  execSync(`git clone -q "${bare}" "${other}"`);
  execSync('git config user.email renato@t', { cwd: other });
  execSync('git config user.name renato', { cwd: other });
  execSync('git config commit.gpgsign false', { cwd: other });

  return { local, bare, other, cleanup: () => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }};
}

function makeFs(root: string): SyncFs {
  return {
    read: async (rel) => fsp.readFile(path.join(root, rel), 'utf8').catch(() => ''),
    write: async (rel, content) => {
      const abs = path.join(root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
    },
  };
}

describe('SyncWorker integration (real git)', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });
  afterEach(() => env.cleanup());

  it('happy path: enqueue → tick → push → other clone sees commit', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    const idx = new VaultIndex(env.local); await idx.build();
    const git = new GitOps(env.local);
    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git, idx, makeFs(env.local),
    );

    fs.mkdirSync(path.join(env.local, '_agents/alfa'), { recursive: true });
    fs.writeFileSync(path.join(env.local, '_agents/alfa/note1.md'), `---
type: agent-readme
owner: alfa
created: 2026-04-01
updated: 2026-04-26
tags: []
---
hello`);
    queue.enqueue({ path: '_agents/alfa/note1.md', message: '[mcp] write_note: _agents/alfa/note1.md', as_agent: 'alfa', tool: 'write_note' });

    await (w as any).tick();

    execSync('git pull -q origin main', { cwd: env.other });
    expect(fs.existsSync(path.join(env.other, '_agents/alfa/note1.md'))).toBe(true);
    const otherLog = execSync('git log --format=%s -1', { cwd: env.other }).toString().trim();
    expect(otherLog).toBe('[mcp] write_note: _agents/alfa/note1.md');
  });

  it('Renato pushes first: tick pulls + refreshes index', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    const idx = new VaultIndex(env.local); await idx.build();
    const git = new GitOps(env.local);
    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git, idx, makeFs(env.local),
    );

    fs.mkdirSync(path.join(env.other, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(env.other, '_shared/context/fama.md'), `---
type: shared-context
owner: renato
topic: fama
title: Visão
created: 2026-04-26
updated: 2026-04-26
tags: []
---
viva`);
    execSync('git add . && git commit -q -m "renato edit" && git push -q origin main', { cwd: env.other });

    await (w as any).tick();
    expect(fs.existsSync(path.join(env.local, '_shared/context/fama.md'))).toBe(true);
    expect(idx.get('_shared/context/fama.md')?.frontmatter?.title).toBe('Visão');
  });
});
