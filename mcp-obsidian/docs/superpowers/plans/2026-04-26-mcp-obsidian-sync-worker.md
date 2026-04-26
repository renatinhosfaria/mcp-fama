# mcp-obsidian Sync Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o cron `brain-sync.sh` (5min, host) por um `SyncWorker` in-process (30s, container) que faz `fetch + pull --rebase --autostash + drain queue + push`, com política "MCP wins por arquivo" em conflitos.

**Architecture:** Worker baseado em `setInterval(30s)` dentro do processo MCP. `CommitQueue` FIFO in-memory recebe `{path, message}` após cada write. `ResolutionLock` per-path bloqueia writes de tools brevemente durante a fase de conflito. `GitOps` ganha métodos para `fetch`, `pullRebase`, `commit`, `push` com erros estruturados (não-throw). `VaultIndex.refreshPaths(paths[])` reindex seletivo após pull.

**Tech Stack:** TypeScript strict ESM (NodeNext), Node 20, `simple-git` 3.27, Vitest 2.1, Express 4. SSH deploy key montada como volume read-only no container Alpine.

**Spec:** `docs/superpowers/specs/2026-04-26-mcp-obsidian-sync-worker-design.md`

---

## Convenções

- Todos os comandos `npm` rodam em `/root/mcp-fama/mcp-obsidian` (ou subpath, se cwd for `/root/mcp-fama/`).
- Padrão de commit: `feat(vault): ...`, `feat(tools): ...`, `test(...)`, `chore(deploy): ...`. Sufixo `(plan-8/<n>)` opcional.
- TDD strict: red → green → refactor. Sem step de "implementar sem teste".
- Vitest globals (`describe/it/expect`) já configurados no projeto.

---

## Task 1: CommitQueue

**Files:**
- Create: `src/vault/commit-queue.ts`
- Test: `test/unit/commit-queue.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/unit/commit-queue.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CommitQueue } from '../../src/vault/commit-queue.js';

describe('CommitQueue', () => {
  let q: CommitQueue;
  beforeEach(() => { q = new CommitQueue(); });

  it('starts empty', () => {
    expect(q.size()).toBe(0);
    expect(q.shift()).toBeUndefined();
    expect(q.pendingPaths().size).toBe(0);
  });

  it('enqueue + shift in FIFO order', () => {
    q.enqueue({ path: 'a.md', message: 'm1', as_agent: 'alfa', tool: 'write_note' });
    q.enqueue({ path: 'b.md', message: 'm2', as_agent: 'alfa', tool: 'append_to_note' });
    expect(q.size()).toBe(2);
    const j1 = q.shift();
    expect(j1?.path).toBe('a.md');
    expect(j1?.message).toBe('m1');
    expect(typeof j1?.enqueuedAt).toBe('number');
    const j2 = q.shift();
    expect(j2?.path).toBe('b.md');
    expect(q.size()).toBe(0);
  });

  it('pendingPaths returns distinct set', () => {
    q.enqueue({ path: 'a.md', message: 'm1', as_agent: 'alfa', tool: 't' });
    q.enqueue({ path: 'a.md', message: 'm2', as_agent: 'alfa', tool: 't' });
    q.enqueue({ path: 'b.md', message: 'm3', as_agent: 'alfa', tool: 't' });
    expect(q.pendingPaths().size).toBe(2);
    expect(q.pendingPaths().has('a.md')).toBe(true);
    expect(q.pendingPaths().has('b.md')).toBe(true);
  });

  it('drain returns all jobs and empties queue', () => {
    q.enqueue({ path: 'a.md', message: 'm1', as_agent: 'alfa', tool: 't' });
    q.enqueue({ path: 'b.md', message: 'm2', as_agent: 'alfa', tool: 't' });
    const drained = q.drain();
    expect(drained.length).toBe(2);
    expect(drained[0].path).toBe('a.md');
    expect(drained[1].path).toBe('b.md');
    expect(q.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/commit-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CommitQueue**

Create `src/vault/commit-queue.ts`:

```ts
export interface CommitJob {
  path: string;
  message: string;
  enqueuedAt: number;
  as_agent: string;
  tool: string;
}

export type CommitJobInput = Omit<CommitJob, 'enqueuedAt'>;

export class CommitQueue {
  private items: CommitJob[] = [];

  enqueue(job: CommitJobInput): void {
    this.items.push({ ...job, enqueuedAt: Date.now() });
  }

  shift(): CommitJob | undefined {
    return this.items.shift();
  }

  size(): number {
    return this.items.length;
  }

  pendingPaths(): Set<string> {
    return new Set(this.items.map(i => i.path));
  }

  drain(): CommitJob[] {
    const all = this.items;
    this.items = [];
    return all;
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/commit-queue.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/commit-queue.ts test/unit/commit-queue.test.ts
git commit -m "feat(vault): add CommitQueue (plan-8/1)"
```

---

## Task 2: ResolutionLock

**Files:**
- Create: `src/vault/resolution-lock.ts`
- Test: `test/unit/resolution-lock.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/unit/resolution-lock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';

describe('ResolutionLock', () => {
  it('acquire is noop when not locked', async () => {
    const lock = new ResolutionLock();
    const start = Date.now();
    await lock.acquire(['a.md']);
    expect(Date.now() - start).toBeLessThan(20);
    lock.release();
  });

  it('acquire blocks while a path is locked, unblocks on release', async () => {
    const lock = new ResolutionLock();
    const order: string[] = [];

    // Worker locks paths
    lock.lockPaths(['a.md']);
    order.push('worker-locked');

    // Tool tries to acquire concurrently
    const toolPromise = (async () => {
      order.push('tool-await');
      await lock.acquire(['a.md']);
      order.push('tool-acquired');
      lock.release();
    })();

    // Allow microtask queue to flush
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual(['worker-locked', 'tool-await']);

    // Worker releases
    lock.unlockPaths();
    order.push('worker-unlocked');
    await toolPromise;
    expect(order).toEqual(['worker-locked', 'tool-await', 'worker-unlocked', 'tool-acquired']);
  });

  it('acquire on disjoint paths is noop', async () => {
    const lock = new ResolutionLock();
    lock.lockPaths(['a.md']);
    const start = Date.now();
    await lock.acquire(['b.md']);
    expect(Date.now() - start).toBeLessThan(20);
    lock.release();
    lock.unlockPaths();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/resolution-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ResolutionLock**

Create `src/vault/resolution-lock.ts`:

```ts
export class ResolutionLock {
  private lockedPaths: Set<string> = new Set();
  private waiters: Array<() => void> = [];

  /** Worker calls this before snapshot+reset+restore. */
  lockPaths(paths: string[]): void {
    for (const p of paths) this.lockedPaths.add(p);
  }

  /** Worker calls this after restore completes. Wakes all waiters. */
  unlockPaths(): void {
    this.lockedPaths.clear();
    const wakeUp = this.waiters;
    this.waiters = [];
    for (const w of wakeUp) w();
  }

  /** Tool calls this before its writeFileAtomic. Resolves immediately if no
   *  overlap with locked paths; otherwise awaits unlockPaths. */
  async acquire(paths: string[]): Promise<void> {
    if (!this.hasOverlap(paths)) return;
    await new Promise<void>(resolve => { this.waiters.push(resolve); });
    if (this.hasOverlap(paths)) return this.acquire(paths);
  }

  /** Tool calls this after its enqueue. Currently noop — kept for API
   *  symmetry and future extension. */
  release(): void { /* noop */ }

  private hasOverlap(paths: string[]): boolean {
    for (const p of paths) if (this.lockedPaths.has(p)) return true;
    return false;
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/resolution-lock.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/resolution-lock.ts test/unit/resolution-lock.test.ts
git commit -m "feat(vault): add ResolutionLock (plan-8/2)"
```

---

## Task 3: GitOps extensions — fetch / isLocalBehind / diffNames

**Files:**
- Modify: `src/vault/git.ts`
- Test: `test/unit/git.test.ts` (existente, estender)

- [ ] **Step 1: Write failing tests**

Append to `test/unit/git.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitOps } from '../../src/vault/git.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('GitOps extensions', () => {
  let local: string; let bare: string;

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
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/git.test.ts`
Expected: FAIL — `g.fetch is not a function`.

- [ ] **Step 3: Extend GitOps**

Edit `src/vault/git.ts`. Replace the file with:

```ts
import { simpleGit, SimpleGit } from 'simple-git';
import { McpError } from '../errors.js';

export interface StatusResult { modified: string[]; untracked: string[]; ahead: number; behind: number; }

export class GitOps {
  private git: SimpleGit;
  constructor(cwd: string) {
    this.git = simpleGit(cwd);
  }

  async status(): Promise<StatusResult> {
    try {
      const s = await this.git.status();
      return {
        modified: [...s.modified, ...s.renamed.map((r: any) => r.to)],
        untracked: s.not_added,
        ahead: s.ahead,
        behind: s.behind,
      };
    } catch (e: any) {
      throw new McpError('VAULT_IO_ERROR', `git status failed: ${e.message}`);
    }
  }

  async head(): Promise<string | null> {
    try { return (await this.git.revparse(['HEAD'])).trim(); }
    catch { return null; }
  }

  async fetch(remote: string, branch: string): Promise<void> {
    await this.git.fetch(remote, branch);
  }

  async isLocalBehind(remote: string, branch: string): Promise<boolean> {
    const out = await this.git.raw(['rev-list', '--count', `HEAD..${remote}/${branch}`]);
    return parseInt(out.trim(), 10) > 0;
  }

  async diffNames(from: string, to: string): Promise<string[]> {
    const out = await this.git.raw(['diff', '--name-only', `${from}..${to}`]);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/git.test.ts`
Expected: PASS, all describes including new "GitOps extensions".

- [ ] **Step 5: Commit**

```bash
git add src/vault/git.ts test/unit/git.test.ts
git commit -m "feat(vault): GitOps fetch/isLocalBehind/diffNames (plan-8/3)"
```

---

## Task 4: GitOps extensions — pullRebase / rebaseAbort / resetHard

**Files:**
- Modify: `src/vault/git.ts`
- Test: `test/unit/git.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/unit/git.test.ts` inside the `describe('GitOps extensions', ...)`:

```ts
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
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/git.test.ts`
Expected: FAIL — `g.pullRebase is not a function`.

- [ ] **Step 3: Extend GitOps**

Add methods inside the `GitOps` class in `src/vault/git.ts`:

```ts
  async pullRebase(remote: string, branch: string): Promise<void> {
    await this.git.raw(['pull', '--rebase', '--autostash', remote, branch]);
  }

  async rebaseAbort(): Promise<void> {
    try { await this.git.raw(['rebase', '--abort']); }
    catch { /* nothing to abort */ }
  }

  async resetHard(ref: string): Promise<void> {
    await this.git.raw(['reset', '--hard', ref]);
  }
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/git.test.ts`
Expected: PASS, including 2 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/git.ts test/unit/git.test.ts
git commit -m "feat(vault): GitOps pullRebase/rebaseAbort/resetHard (plan-8/4)"
```

---

## Task 5: GitOps extensions — add / commit / push (com erro estruturado)

**Files:**
- Modify: `src/vault/git.ts`
- Test: `test/unit/git.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/unit/git.test.ts` inside the same `describe('GitOps extensions', ...)`:

```ts
  it('add + commit + push happy path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-acp-'));
    execSync(`git clone -q "${bare}" "${tmp}"`);
    execSync('git config user.email t@t', { cwd: tmp });
    execSync('git config user.name t', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'new.md'), 'data');

    const g = new GitOps(tmp);
    await g.add('new.md');
    const c = await g.commit('feat: add new');
    expect(c?.sha).toMatch(/^[0-9a-f]{7,40}$/);
    const pushRes = await g.push('origin', 'main');
    expect(pushRes.ok).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('commit returns null when nothing staged', async () => {
    const g = new GitOps(local);
    const c = await g.commit('noop');
    expect(c).toBeNull();
  });

  it('push returns structured non-fast-forward error', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-nff-'));
    execSync(`git clone -q "${bare}" "${tmp}"`);
    execSync('git config user.email t@t', { cwd: tmp });
    execSync('git config user.name t', { cwd: tmp });

    // Outsider pushes a divergent commit
    const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-out-'));
    execSync(`git clone -q "${bare}" "${otherClone}"`);
    execSync('git config user.email o@o', { cwd: otherClone });
    execSync('git config user.name o', { cwd: otherClone });
    fs.writeFileSync(path.join(otherClone, 'race.md'), 'A');
    execSync('git add . && git commit -q -m A && git push -q origin main', { cwd: otherClone });

    // Local makes its own divergent commit
    fs.writeFileSync(path.join(tmp, 'race.md'), 'B');
    const g = new GitOps(tmp);
    await g.add('race.md');
    await g.commit('local race');
    const r = await g.push('origin', 'main');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('non-fast-forward');

    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(otherClone, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/git.test.ts`
Expected: FAIL — `g.add is not a function`.

- [ ] **Step 3: Extend GitOps**

Add methods inside `GitOps` class in `src/vault/git.ts`:

```ts
  async add(rel: string): Promise<void> {
    await this.git.add(rel);
  }

  async commit(message: string): Promise<{ sha: string } | null> {
    const r = await this.git.commit(message);
    if (!r.commit || r.commit === '') return null;
    return { sha: r.commit };
  }

  async push(remote: string, branch: string):
    Promise<{ ok: true } | { ok: false; reason: 'non-fast-forward' | 'network' | 'auth' | 'unknown'; detail: string }>
  {
    try {
      await this.git.push(remote, branch);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e.message ?? e);
      if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
        return { ok: false, reason: 'non-fast-forward', detail: msg };
      }
      if (/Could not resolve host|connection|timed out|network/i.test(msg)) {
        return { ok: false, reason: 'network', detail: msg };
      }
      if (/permission denied|authentication|publickey|access denied/i.test(msg)) {
        return { ok: false, reason: 'auth', detail: msg };
      }
      return { ok: false, reason: 'unknown', detail: msg };
    }
  }
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/git.test.ts`
Expected: PASS, all GitOps extensions tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/git.ts test/unit/git.test.ts
git commit -m "feat(vault): GitOps add/commit/push with structured errors (plan-8/5)"
```

---

## Task 6: VaultIndex.refreshPaths

**Files:**
- Modify: `src/vault/index.ts`
- Test: `test/unit/index.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/unit/index.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';

describe('VaultIndex.refreshPaths', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rp-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
    fs.mkdirSync(path.join(tmp, '_agents/alfa'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_agents/alfa/profile.md'), `---
type: agent-profile
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
hello`);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('refreshPaths reindexes a single file after disk change', async () => {
    const idx = new VaultIndex(tmp);
    await idx.build();
    expect(idx.get('_agents/alfa/profile.md')?.tags).toEqual([]);

    fs.writeFileSync(path.join(tmp, '_agents/alfa/profile.md'), `---
type: agent-profile
owner: alfa
created: 2026-04-01
updated: 2026-04-15
tags: [updated]
---
new content`);
    await idx.refreshPaths(['_agents/alfa/profile.md']);
    expect(idx.get('_agents/alfa/profile.md')?.tags).toEqual(['updated']);
  });

  it('refreshPaths removes entry when file deleted', async () => {
    const idx = new VaultIndex(tmp);
    await idx.build();
    fs.writeFileSync(path.join(tmp, '_agents/alfa/temp.md'), `---
type: agent-readme
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
x`);
    await idx.refreshPaths(['_agents/alfa/temp.md']);
    expect(idx.get('_agents/alfa/temp.md')).toBeDefined();
    fs.unlinkSync(path.join(tmp, '_agents/alfa/temp.md'));
    await idx.refreshPaths(['_agents/alfa/temp.md']);
    expect(idx.get('_agents/alfa/temp.md')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/index.test.ts`
Expected: FAIL — `idx.refreshPaths is not a function`.

- [ ] **Step 3: Add `refreshPaths` to VaultIndex**

In `src/vault/index.ts`, add this method to the `VaultIndex` class (next to `updateAfterWrite`):

```ts
  async refreshPaths(paths: string[]): Promise<void> {
    for (const rel of paths) {
      this.removeEntry(rel);
      const abs = path.join(this.vaultRoot, rel);
      let st;
      try { st = await fsp.stat(abs); }
      catch { continue; }
      if (!rel.endsWith('.md')) continue;
      await this.indexFile(abs, st.mtimeMs, st.size);
    }
  }
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/index.test.ts`
Expected: PASS, including 2 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.ts test/unit/index.test.ts
git commit -m "feat(vault): VaultIndex.refreshPaths for selective reindex (plan-8/6)"
```

---

## Task 7: SyncWorker — shell (constructor, start/stop/getStatus)

**Files:**
- Create: `src/vault/sync-worker.ts`
- Test: `test/unit/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/unit/sync-worker.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SyncWorker } from '../../src/vault/sync-worker.js';
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';

// Minimal fakes for git + index. Specific tasks below extend these.
function fakeGit() {
  return {
    fetch: async () => {},
    isLocalBehind: async () => false,
    diffNames: async () => [],
    pullRebase: async () => {},
    rebaseAbort: async () => {},
    resetHard: async () => {},
    add: async () => {},
    commit: async () => null,
    push: async () => ({ ok: true as const }),
  };
}
function fakeIndex() {
  return { refreshPaths: async (_: string[]) => {} };
}
function fakeFs() {
  return {
    read: async (_: string) => '',
    write: async (_: string, __: string) => {},
  };
}

describe('SyncWorker shell', () => {
  let queue: CommitQueue; let lock: ResolutionLock;
  beforeEach(() => { queue = new CommitQueue(); lock = new ResolutionLock(); });

  it('getStatus initial state', () => {
    const w = new SyncWorker(
      { intervalMs: 30_000, remote: 'origin', branch: 'main' },
      queue, lock, fakeGit() as any, fakeIndex() as any, fakeFs(),
    );
    const s = w.getStatus();
    expect(s.queueSize).toBe(0);
    expect(s.lastTickAt).toBeNull();
    expect(s.lastTickOutcome).toBeNull();
    expect(s.totalTicks).toBe(0);
    expect(s.totalCommitsPushed).toBe(0);
    expect(s.totalConflictsResolved).toBe(0);
  });

  it('start + stop without firing tick', async () => {
    const w = new SyncWorker(
      { intervalMs: 30_000, remote: 'origin', branch: 'main' },
      queue, lock, fakeGit() as any, fakeIndex() as any, fakeFs(),
    );
    w.start();
    await w.stop();
    expect(w.getStatus().totalTicks).toBe(0);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement SyncWorker shell**

Create `src/vault/sync-worker.ts`:

```ts
import { CommitQueue } from './commit-queue.js';
import { ResolutionLock } from './resolution-lock.js';
import { GitOps } from './git.js';
import { VaultIndex } from './index.js';

export interface SyncWorkerOptions {
  intervalMs: number;
  remote: string;
  branch: string;
}

export type TickOutcome =
  | 'ok'
  | 'conflict_resolved'
  | 'push_failed_retry'
  | 'rebase_failed'
  | 'fetch_failed'
  | 'auth_failed';

export interface SyncWorkerStatus {
  queueSize: number;
  lastTickAt: string | null;
  lastTickOutcome: TickOutcome | null;
  lastError: string | null;
  totalTicks: number;
  totalCommitsPushed: number;
  totalConflictsResolved: number;
  lastConflict: { at: string; files: string[]; remote_sha_overridden: string; mcp_paths_kept: string[] } | null;
}

export interface SyncFs {
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
}

export class SyncWorker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  private status: SyncWorkerStatus = {
    queueSize: 0,
    lastTickAt: null,
    lastTickOutcome: null,
    lastError: null,
    totalTicks: 0,
    totalCommitsPushed: 0,
    totalConflictsResolved: 0,
    lastConflict: null,
  };

  constructor(
    private readonly opts: SyncWorkerOptions,
    private readonly queue: CommitQueue,
    private readonly lock: ResolutionLock,
    private readonly git: GitOps,
    private readonly index: VaultIndex,
    private readonly fs: SyncFs,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    while (this.ticking) await new Promise(r => setTimeout(r, 50));
  }

  getStatus(): SyncWorkerStatus {
    return { ...this.status, queueSize: this.queue.size() };
  }

  protected async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.status.totalTicks++;
      this.status.lastTickAt = new Date().toISOString();
      this.status.lastTickOutcome = 'ok';
      this.status.lastError = null;
    } finally {
      this.ticking = false;
    }
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/sync-worker.ts test/unit/sync-worker.test.ts
git commit -m "feat(vault): SyncWorker shell (plan-8/7)"
```

---

## Task 8: SyncWorker.tick — happy path no-op (no remote, no queue)

**Files:**
- Modify: `src/vault/sync-worker.ts`
- Modify: `test/unit/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/unit/sync-worker.test.ts`:

```ts
describe('SyncWorker.tick happy path no-op', () => {
  it('fetch but no remote ahead, no queue → outcome ok', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    const calls: string[] = [];
    const git = {
      ...fakeGit(),
      fetch: async () => { calls.push('fetch'); },
      isLocalBehind: async () => false,
      push: async () => { calls.push('push'); return { ok: true as const }; },
    };
    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git as any, fakeIndex() as any, fakeFs(),
    );
    await (w as any).tick();
    const s = w.getStatus();
    expect(s.lastTickOutcome).toBe('ok');
    expect(s.totalTicks).toBe(1);
    expect(calls).toContain('fetch');
    // no queue → no push attempt
    expect(calls).not.toContain('push');
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: FAIL — `calls` never contains 'fetch' (current tick stub doesn't call git).

- [ ] **Step 3: Update tick**

In `src/vault/sync-worker.ts`, replace `tick()` with:

```ts
  protected async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    this.status.totalTicks++;
    this.status.lastTickAt = new Date().toISOString();
    this.status.lastError = null;
    try {
      // Phase 1: fetch
      try {
        await this.git.fetch(this.opts.remote, this.opts.branch);
      } catch (e: any) {
        this.status.lastTickOutcome = 'fetch_failed';
        this.status.lastError = e.message ?? String(e);
        return;
      }

      // Phase 2: detect remote changes (deferred to next task)
      // Phase 3: drain queue (deferred to next task)
      // Phase 4: push if anything to push (deferred to next task)

      this.status.lastTickOutcome = 'ok';
    } finally {
      this.ticking = false;
    }
  }
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/sync-worker.ts test/unit/sync-worker.test.ts
git commit -m "feat(vault): SyncWorker.tick fetch phase (plan-8/8)"
```

---

## Task 9: SyncWorker.tick — pull clean (no overlap)

**Files:**
- Modify: `src/vault/sync-worker.ts`
- Modify: `test/unit/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/unit/sync-worker.test.ts`:

```ts
describe('SyncWorker.tick pull clean (no overlap)', () => {
  it('remote ahead with no queue overlap → pullRebase + refreshPaths', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    const calls: string[] = [];
    const git = {
      ...fakeGit(),
      fetch: async () => { calls.push('fetch'); },
      isLocalBehind: async () => true,
      diffNames: async (from: string, to: string) => {
        if (from === 'HEAD' && to === 'origin/main') return ['_shared/context/fama/visao.md'];
        if (from === 'origin/main' && to === 'HEAD') return [];
        return [];
      },
      pullRebase: async () => { calls.push('pullRebase'); },
    };
    const refreshed: string[] = [];
    const idx = { refreshPaths: async (paths: string[]) => { refreshed.push(...paths); } };

    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git as any, idx as any, fakeFs(),
    );
    await (w as any).tick();
    expect(calls).toEqual(['fetch', 'pullRebase']);
    expect(refreshed).toEqual(['_shared/context/fama/visao.md']);
    expect(w.getStatus().lastTickOutcome).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: FAIL — `pullRebase` never called.

- [ ] **Step 3: Implement pull-clean phase**

In `src/vault/sync-worker.ts`, replace the body of `tick()` with:

```ts
  protected async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    this.status.totalTicks++;
    this.status.lastTickAt = new Date().toISOString();
    this.status.lastError = null;
    try {
      try {
        await this.git.fetch(this.opts.remote, this.opts.branch);
      } catch (e: any) {
        this.status.lastTickOutcome = 'fetch_failed';
        this.status.lastError = e.message ?? String(e);
        return;
      }

      const behind = await this.git.isLocalBehind(this.opts.remote, this.opts.branch);
      if (behind) {
        const remoteChanged = await this.git.diffNames('HEAD', `${this.opts.remote}/${this.opts.branch}`);
        const localUnpushed = await this.git.diffNames(`${this.opts.remote}/${this.opts.branch}`, 'HEAD');
        const ourTouched = new Set([...this.queue.pendingPaths(), ...localUnpushed]);
        const overlap = remoteChanged.filter(p => ourTouched.has(p));

        if (overlap.length === 0) {
          try {
            await this.git.pullRebase(this.opts.remote, this.opts.branch);
            await this.index.refreshPaths(remoteChanged);
          } catch (e: any) {
            await this.git.rebaseAbort();
            this.status.lastTickOutcome = 'rebase_failed';
            this.status.lastError = e.message ?? String(e);
            return;
          }
        } else {
          // Conflict resolution path — implemented in Task 13
          this.status.lastTickOutcome = 'conflict_resolved';
          this.status.lastError = 'overlap detected, resolution path not yet implemented';
          return;
        }
      }

      this.status.lastTickOutcome = 'ok';
    } finally {
      this.ticking = false;
    }
  }
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/sync-worker.ts test/unit/sync-worker.test.ts
git commit -m "feat(vault): SyncWorker.tick pull-clean phase (plan-8/9)"
```

---

## Task 10: SyncWorker.tick — drain queue + commit + push

**Files:**
- Modify: `src/vault/sync-worker.ts`
- Modify: `test/unit/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/unit/sync-worker.test.ts`:

```ts
describe('SyncWorker.tick drain + push', () => {
  it('drains queue: 1 add+commit per job, then push', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    queue.enqueue({ path: 'a.md', message: '[mcp] write_note: a.md', as_agent: 'alfa', tool: 'write_note' });
    queue.enqueue({ path: 'b.md', message: '[mcp] write_note: b.md', as_agent: 'alfa', tool: 'write_note' });

    const calls: string[] = [];
    const git = {
      ...fakeGit(),
      add: async (p: string) => { calls.push(`add:${p}`); },
      commit: async (m: string) => { calls.push(`commit:${m}`); return { sha: 'abc1234' }; },
      push: async () => { calls.push('push'); return { ok: true as const }; },
    };
    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git as any, fakeIndex() as any, fakeFs(),
    );
    await (w as any).tick();

    expect(calls).toEqual([
      'add:a.md', 'commit:[mcp] write_note: a.md',
      'add:b.md', 'commit:[mcp] write_note: b.md',
      'push',
    ]);
    expect(queue.size()).toBe(0);
    expect(w.getStatus().totalCommitsPushed).toBe(2);
    expect(w.getStatus().lastTickOutcome).toBe('ok');
  });

  it('push fail non-fast-forward keeps commits, sets outcome push_failed_retry', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    queue.enqueue({ path: 'a.md', message: 'm', as_agent: 'alfa', tool: 'write_note' });
    const git = {
      ...fakeGit(),
      add: async () => {},
      commit: async () => ({ sha: 'abc' }),
      push: async () => ({ ok: false as const, reason: 'non-fast-forward' as const, detail: 'rejected' }),
    };
    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git as any, fakeIndex() as any, fakeFs(),
    );
    await (w as any).tick();
    expect(w.getStatus().lastTickOutcome).toBe('push_failed_retry');
    expect(queue.size()).toBe(0); // commits were drained, but stayed local
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: FAIL — calls don't include add/commit/push.

- [ ] **Step 3: Implement drain + push**

In `src/vault/sync-worker.ts`, replace the body of `tick()` (just before the final `this.status.lastTickOutcome = 'ok';`) — i.e., add **drain queue + push** section so the method becomes:

```ts
  protected async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    this.status.totalTicks++;
    this.status.lastTickAt = new Date().toISOString();
    this.status.lastError = null;
    try {
      try {
        await this.git.fetch(this.opts.remote, this.opts.branch);
      } catch (e: any) {
        this.status.lastTickOutcome = 'fetch_failed';
        this.status.lastError = e.message ?? String(e);
        return;
      }

      const behind = await this.git.isLocalBehind(this.opts.remote, this.opts.branch);
      if (behind) {
        const remoteChanged = await this.git.diffNames('HEAD', `${this.opts.remote}/${this.opts.branch}`);
        const localUnpushed = await this.git.diffNames(`${this.opts.remote}/${this.opts.branch}`, 'HEAD');
        const ourTouched = new Set([...this.queue.pendingPaths(), ...localUnpushed]);
        const overlap = remoteChanged.filter(p => ourTouched.has(p));

        if (overlap.length === 0) {
          try {
            await this.git.pullRebase(this.opts.remote, this.opts.branch);
            await this.index.refreshPaths(remoteChanged);
          } catch (e: any) {
            await this.git.rebaseAbort();
            this.status.lastTickOutcome = 'rebase_failed';
            this.status.lastError = e.message ?? String(e);
            return;
          }
        } else {
          this.status.lastTickOutcome = 'conflict_resolved';
          this.status.lastError = 'overlap detected, resolution path not yet implemented';
          return;
        }
      }

      // Drain queue
      let drained = 0;
      while (this.queue.size() > 0) {
        const job = this.queue.shift()!;
        await this.git.add(job.path);
        const c = await this.git.commit(job.message);
        if (c) drained++;
      }

      // Push if there's anything to push
      if (drained > 0 || (await this.git.diffNames(`${this.opts.remote}/${this.opts.branch}`, 'HEAD')).length > 0) {
        const r = await this.git.push(this.opts.remote, this.opts.branch);
        if (r.ok) {
          this.status.totalCommitsPushed += drained;
        } else if (r.reason === 'non-fast-forward') {
          this.status.lastTickOutcome = 'push_failed_retry';
          this.status.lastError = r.detail;
          return;
        } else if (r.reason === 'auth') {
          this.status.lastTickOutcome = 'auth_failed';
          this.status.lastError = r.detail;
          return;
        } else {
          this.status.lastTickOutcome = 'push_failed_retry';
          this.status.lastError = r.detail;
          return;
        }
      }

      this.status.lastTickOutcome = 'ok';
    } finally {
      this.ticking = false;
    }
  }
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/sync-worker.ts test/unit/sync-worker.test.ts
git commit -m "feat(vault): SyncWorker.tick drain queue + push with retry (plan-8/10)"
```

---

## Task 11: SyncWorker.resolveOverlap (snapshot + reset + restore + re-enqueue)

**Files:**
- Modify: `src/vault/sync-worker.ts`
- Modify: `test/unit/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/unit/sync-worker.test.ts`:

```ts
describe('SyncWorker.resolveOverlap', () => {
  it('overlap → snapshot, resetHard, restore, re-enqueue, increment counter', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    queue.enqueue({ path: 'visao.md', message: '[mcp] write_note: visao.md', as_agent: 'alfa', tool: 'write_note' });

    const fsContents = new Map<string, string>([['visao.md', 'mcp-version']]);
    const fs = {
      read: async (rel: string) => fsContents.get(rel) ?? '',
      write: async (rel: string, content: string) => { fsContents.set(rel, content); },
    };
    const calls: string[] = [];
    const git = {
      ...fakeGit(),
      isLocalBehind: async () => true,
      diffNames: async (from: string, to: string) => {
        if (from === 'HEAD' && to === 'origin/main') return ['visao.md'];
        if (from === 'origin/main' && to === 'HEAD') return [];
        return [];
      },
      resetHard: async (ref: string) => {
        calls.push(`resetHard:${ref}`);
        fsContents.set('visao.md', 'remote-version');
      },
      head: async () => 'remote-sha-abc1234',
      add: async (p: string) => { calls.push(`add:${p}`); },
      commit: async (m: string) => { calls.push(`commit:${m}`); return { sha: 'newsha' }; },
      push: async () => ({ ok: true as const }),
    };

    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git as any, fakeIndex() as any, fs,
    );
    await (w as any).tick();

    // After resolution, FS should have MCP version restored
    expect(fsContents.get('visao.md')).toBe('mcp-version');
    expect(calls).toContain('resetHard:origin/main');
    expect(calls.filter(c => c.startsWith('add:visao.md')).length).toBeGreaterThanOrEqual(1);
    expect(w.getStatus().totalConflictsResolved).toBe(1);
    expect(w.getStatus().lastConflict?.files).toEqual(['visao.md']);
    expect(w.getStatus().lastConflict?.mcp_paths_kept).toEqual(['visao.md']);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: FAIL — `fsContents.get('visao.md')` is `'remote-version'` (resolution not implemented).

- [ ] **Step 3: Implement resolveOverlap**

In `src/vault/sync-worker.ts`:

a) Add at the top of file, importing `head` if needed (already on the GitOps interface — no import change). Then add a method to the class, just below `tick`:

```ts
  private async resolveOverlap(remoteChanged: string[], overlap: string[]): Promise<void> {
    // Snapshot MCP versions BEFORE reset
    this.lock.lockPaths(overlap);
    const snapshot = new Map<string, string>();
    for (const p of overlap) snapshot.set(p, await this.fs.read(p));
    let remoteSha = '';
    try { remoteSha = (await (this.git as any).head?.()) ?? ''; } catch { remoteSha = ''; }

    try {
      await this.git.rebaseAbort();          // safe noop if no rebase in progress
      await this.git.resetHard(`${this.opts.remote}/${this.opts.branch}`);
      for (const [p, content] of snapshot) {
        await this.fs.write(p, content);
      }
    } finally {
      this.lock.unlockPaths();
    }

    // Reindex non-overlapping remote changes
    const nonOverlap = remoteChanged.filter(p => !overlap.includes(p));
    if (nonOverlap.length > 0) await this.index.refreshPaths(nonOverlap);

    // Re-enqueue overlap files for commit (reset --hard cleared staging)
    const pending = this.queue.pendingPaths();
    for (const p of overlap) {
      if (!pending.has(p)) {
        this.queue.enqueue({
          path: p,
          message: `[mcp] resolve_conflict: ${p} (kept local over remote ${remoteSha.slice(0, 7)})`,
          as_agent: 'sync-worker',
          tool: 'sync-worker',
        });
      }
    }

    this.status.totalConflictsResolved++;
    this.status.lastConflict = {
      at: new Date().toISOString(),
      files: [...overlap],
      remote_sha_overridden: remoteSha,
      mcp_paths_kept: [...overlap],
    };
  }
```

b) Replace the placeholder `else { ... resolution path not yet implemented ... }` block in `tick()` with:

```ts
        } else {
          await this.resolveOverlap(remoteChanged, overlap);
          this.status.lastTickOutcome = 'conflict_resolved';
        }
```

c) Also extend the fake `GitOps` shape used in the type cast: add `head?: () => Promise<string | null>`. Actually we already access `head` via `(this.git as any).head` — no type change needed. (The real `GitOps` already has `head()`.)

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: PASS, 7 tests. The conflict_resolved test verifies:
- FS restored to MCP version
- `resetHard` called
- file re-staged
- `lastConflict.mcp_paths_kept` = `['visao.md']`

- [ ] **Step 5: Commit**

```bash
git add src/vault/sync-worker.ts test/unit/sync-worker.test.ts
git commit -m "feat(vault): SyncWorker.resolveOverlap MCP-wins per file (plan-8/11)"
```

---

## Task 12: SyncWorker.stop — graceful drain

**Files:**
- Modify: `src/vault/sync-worker.ts`
- Modify: `test/unit/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/unit/sync-worker.test.ts`:

```ts
describe('SyncWorker.stop graceful drain', () => {
  it('drains queue and pushes during stop()', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    queue.enqueue({ path: 'final.md', message: '[mcp] write_note: final.md', as_agent: 'alfa', tool: 'write_note' });
    const calls: string[] = [];
    const git = {
      ...fakeGit(),
      add: async (p: string) => { calls.push(`add:${p}`); },
      commit: async (m: string) => { calls.push(`commit:${m}`); return { sha: 'sha1' }; },
      push: async () => { calls.push('push'); return { ok: true as const }; },
    };
    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git as any, fakeIndex() as any, fakeFs(),
    );
    w.start();
    await w.stop();
    expect(calls).toContain('add:final.md');
    expect(calls).toContain('push');
    expect(queue.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: FAIL — `calls` does not contain `add:final.md` (stop doesn't currently drain).

- [ ] **Step 3: Update stop()**

In `src/vault/sync-worker.ts`, replace `stop()`:

```ts
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    while (this.ticking) await new Promise(r => setTimeout(r, 50));
    // Final drain — bypass `stopped` guard via internal invocation
    this.stopped = false;
    try {
      await this.tick();
    } finally {
      this.stopped = true;
    }
  }
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/sync-worker.ts test/unit/sync-worker.test.ts
git commit -m "feat(vault): SyncWorker graceful shutdown drain (plan-8/12)"
```

---

## Task 13: Config — new env vars

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `test/unit/config.test.ts` (existente, estender)

- [ ] **Step 1: Write failing test**

Append to `test/unit/config.test.ts`:

```ts
describe('config — sync worker env vars', () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it('SYNC_INTERVAL_MS defaults to 30000 when unset', async () => {
    delete process.env.SYNC_INTERVAL_MS;
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    const mod = await import('../../src/config.js?fresh1');
    expect(mod.config.syncIntervalMs).toBe(30000);
  });

  it('SYNC_ENABLED defaults to true when unset', async () => {
    delete process.env.SYNC_ENABLED;
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    const mod = await import('../../src/config.js?fresh2');
    expect(mod.config.syncEnabled).toBe(true);
  });

  it('SYNC_ENABLED=false disables', async () => {
    process.env.SYNC_ENABLED = 'false';
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    const mod = await import('../../src/config.js?fresh3');
    expect(mod.config.syncEnabled).toBe(false);
  });

  it('GIT_REMOTE / GIT_BRANCH defaults', async () => {
    delete process.env.GIT_REMOTE; delete process.env.GIT_BRANCH;
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    const mod = await import('../../src/config.js?fresh4');
    expect(mod.config.gitRemote).toBe('origin');
    expect(mod.config.gitBranch).toBe('main');
  });
});
```

(The `?fresh1` query string defeats Node ESM caching across the test file.)

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/unit/config.test.ts`
Expected: FAIL — `config.syncIntervalMs is undefined`.

- [ ] **Step 3: Update config.ts**

Replace `src/config.ts` with:

```ts
import 'dotenv/config';
import fs from 'node:fs';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env var: ${name}`);
  return v;
}
function optional(name: string, def: string): string {
  return process.env[name] ?? def;
}

function loadApiKey(): string {
  const keyFile = process.env.API_KEY_FILE;
  if (keyFile && keyFile.trim() !== '') {
    try {
      const content = fs.readFileSync(keyFile, 'utf8').trim();
      if (content) return content;
    } catch (e: any) {
      throw new Error(`API_KEY_FILE set to ${keyFile} but could not read: ${e.message}`);
    }
  }
  return required('API_KEY');
}

function parseBool(s: string): boolean {
  return s.toLowerCase() === 'true' || s === '1';
}

export const config = {
  port: parseInt(optional('PORT', '3201'), 10),
  apiKey: loadApiKey(),
  vaultPath: required('VAULT_PATH'),
  rateLimitRpm: parseInt(optional('RATE_LIMIT_RPM', '300'), 10),
  syncEnabled: parseBool(optional('SYNC_ENABLED', 'true')),
  syncIntervalMs: parseInt(optional('SYNC_INTERVAL_MS', '30000'), 10),
  gitRemote: optional('GIT_REMOTE', 'origin'),
  gitBranch: optional('GIT_BRANCH', 'main'),
};
```

- [ ] **Step 4: Update .env.example**

Replace `.env.example` with:

```
PORT=3201
API_KEY=replace-me-with-a-strong-token
# In production (Docker Swarm), mount this file into the container as /app/.env.
# Keep VAULT_PATH in the container environment as /vault; the container env overrides this file.
VAULT_PATH=/vault
RATE_LIMIT_RPM=300
GIT_AUTHOR_NAME=mcp-obsidian
GIT_AUTHOR_EMAIL=mcp@fama.local

# Sync worker (Plan 8) — replaces brain-sync.sh cron with in-process loop
SYNC_ENABLED=true
SYNC_INTERVAL_MS=30000
GIT_REMOTE=origin
GIT_BRANCH=main
```

- [ ] **Step 5: Run test (expect pass)**

Run: `npm test -- test/unit/config.test.ts`
Expected: PASS, all config tests.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts .env.example test/unit/config.test.ts
git commit -m "feat(config): SYNC_* env vars (plan-8/13)"
```

---

## Task 14: ToolCtx + crud.ts — enqueue after writes

**Files:**
- Modify: `src/tools/_shared.ts`
- Modify: `src/tools/crud.ts`
- Test: `test/integration/crud.test.ts` (smoke that enqueue happens)

- [ ] **Step 1: Write failing test**

Append to `test/integration/crud.test.ts`:

```ts
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';

describe('crud writes enqueue commit jobs', () => {
  it('writeNote enqueues after successful write', async () => {
    const queue = new CommitQueue();
    const lock = new ResolutionLock();
    const idx = new VaultIndex(FIXTURE);
    await idx.build();
    const ctx2 = { index: idx, vaultRoot: FIXTURE, queue, lock };
    const r = await writeNote({
      path: '_agents/alfa/notes/enq.md',
      content: 'x',
      frontmatter: { type: 'agent-readme', owner: 'alfa', created: '2026-04-01', updated: '2026-04-01', tags: [] },
      as_agent: 'alfa',
    }, ctx2 as any);
    expect(r.isError).toBeUndefined();
    expect(queue.size()).toBe(1);
    const job = queue.shift()!;
    expect(job.path).toBe('_agents/alfa/notes/enq.md');
    expect(job.tool).toBe('write_note');
    expect(job.message).toContain('write_note');
    fs.rmSync(path.join(FIXTURE, '_agents/alfa/notes'), { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/integration/crud.test.ts -t "enqueues"`
Expected: FAIL — `queue.size()` is 0 (no enqueue logic yet).

- [ ] **Step 3: Update ToolCtx and write tools**

a) In `src/tools/_shared.ts`, extend the interface and add a helper:

```ts
import { CommitQueue, CommitJobInput } from '../vault/commit-queue.js';
import { ResolutionLock } from '../vault/resolution-lock.js';
// ... (other imports unchanged)

export interface ToolCtx {
  index: VaultIndex;
  vaultRoot: string;
  git?: GitOps;
  queue?: CommitQueue;
  lock?: ResolutionLock;
}

// ... rest unchanged

export async function enqueueWriteJob(ctx: ToolCtx, job: CommitJobInput): Promise<void> {
  if (!ctx.queue) return;
  ctx.queue.enqueue(job);
}

export async function lockPathsForWrite(ctx: ToolCtx, paths: string[]): Promise<void> {
  if (!ctx.lock) return;
  await ctx.lock.acquire(paths);
}
```

b) In `src/tools/crud.ts`, add `enqueueWriteJob` and `lockPathsForWrite` to the import line from `./_shared.js`:

```ts
import { ToolCtx, tryToolBody, ok, ownerCheck, isDecisionsPath, isJournalPath, isVaultAdmin, validateOwners, encodeCursor, decodeCursor, hashQuery, validateTimeRange, mtimeInWindow, enqueueWriteJob, lockPathsForWrite } from './_shared.js';
```

Re-export them on the existing re-export line:

```ts
export { ToolCtx, tryToolBody, ok, ownerCheck, isDecisionsPath, isJournalPath, isVaultAdmin, validateOwners, encodeCursor, decodeCursor, hashQuery, validateTimeRange, mtimeInWindow, enqueueWriteJob, lockPathsForWrite };
```

c) In `writeNote` body, just before `return { path: a.path, created: !exists };` — i.e., after the audit log line — add:

```ts
    await lockPathsForWrite(ctx, [a.path]);
    await enqueueWriteJob(ctx, {
      path: a.path,
      message: `[mcp] write_note: ${a.path}`,
      as_agent: a.as_agent,
      tool: 'write_note',
    });
```

Wait — `lockPathsForWrite` must come **before** the `writeFileAtomic`. Replace the relevant region in `writeNote`:

```ts
    await ownerCheck(ctx, a.path, a.as_agent);

    const fm = { ...a.frontmatter, owner: a.frontmatter.owner ?? a.as_agent };
    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);

    await lockPathsForWrite(ctx, [a.path]);
    const exists = await statFile(safe);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(a.path);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'write_note', as_agent: a.as_agent, path: a.path, action: exists ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, {
      path: a.path,
      message: `[mcp] write_note: ${a.path}`,
      as_agent: a.as_agent,
      tool: 'write_note',
    });

    return { path: a.path, created: !exists };
```

d) Apply the same pattern to `appendToNote` (use `tool: 'append_to_note'` and message `[mcp] append_to_note: ${a.path}`) and `deleteNote` (use `tool: 'delete_note'` and message `[mcp] delete_note: ${a.path}`).

For `deleteNote`, the file was deleted before enqueue — that's OK; `git add` on a deleted path stages the deletion. Place `lockPathsForWrite` before `deleteFile`.

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/integration/crud.test.ts`
Expected: PASS, including new "enqueues" test.

- [ ] **Step 5: Commit**

```bash
git add src/tools/_shared.ts src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(tools): crud enqueues commit jobs + acquires resolution lock (plan-8/14)"
```

---

## Task 15: workflows.ts — enqueue after writes

**Files:**
- Modify: `src/tools/workflows.ts`

- [ ] **Step 1: Write failing test**

Append to `test/integration/workflows.test.ts`:

```ts
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';

describe('workflows enqueue commit jobs', () => {
  it('upsert_lead_timeline enqueues', async () => {
    const queue = new CommitQueue();
    const lock = new ResolutionLock();
    const ctx2: any = { ...ctx, queue, lock };
    const r = await upsertLeadTimeline({
      as_agent: 'alfa',
      lead_name: 'Joao Silva',
      resumo: 'novo lead',
    }, ctx2);
    expect(r.isError).toBeUndefined();
    expect(queue.size()).toBe(1);
    const job = queue.shift()!;
    expect(job.tool).toBe('upsert_lead_timeline');
    expect(job.path).toContain('_agents/alfa/lead/joao-silva.md');
  });
});
```

(Adjust imports/setup at top of `workflows.test.ts` to align with the existing fixture/ctx pattern. If `upsertLeadTimeline` isn't already imported, add it.)

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/integration/workflows.test.ts -t "enqueues"`
Expected: FAIL.

- [ ] **Step 3: Add enqueue to all write workflows**

In `src/tools/workflows.ts`:

a) Import the helpers at the top:

```ts
import { ToolCtx, tryToolBody, ok, ownerCheck, validateOwners, validateTimeRange, mtimeInWindow, parseRelativeOrIsoSince, enqueueWriteJob, lockPathsForWrite } from './_shared.js';
```

b) For each function in this list, after `setLastWriteTs()` and the audit log line, add `await lockPathsForWrite(ctx, [rel]);` **before** `writeFileAtomic` and `await enqueueWriteJob(ctx, { path: rel, message: \`[mcp] <tool>: ${rel}\`, as_agent: <agent>, tool: '<tool>' });` after the audit log:

| Function | tool name | as_agent source |
|---|---|---|
| `createJournalEntry` | `create_journal_entry` | `a.agent` |
| `appendDecision` | `append_decision` | `a.agent` |
| `updateAgentProfile` | `update_agent_profile` | `a.agent` |
| `upsertGoal` (via `upsertPeriodic`) | `upsert_goal` | `a.agent` |
| `upsertResult` (via `upsertPeriodic`) | `upsert_result` | `a.agent` |
| `upsertSharedContext` | `upsert_shared_context` | `a.as_agent` |
| `upsertEntityProfile` | `upsert_entity_profile` | `a.as_agent` |
| `upsertLeadTimeline` | `upsert_lead_timeline` | `a.as_agent` |
| `appendLeadInteraction` | `append_lead_interaction` | `a.as_agent` |
| `upsertBrokerProfile` | `upsert_broker_profile` | `a.as_agent` |
| `appendBrokerInteraction` | `append_broker_interaction` | `a.as_agent` |
| `upsertFinancialSnapshot` | `upsert_financial_snapshot` | `a.as_agent` |

For `upsertPeriodic` (which handles both goal/result), parameterize: pass `tool: \`upsert_${kind}\``.

Pattern for each (using `createJournalEntry` as concrete example):

```ts
    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'create_journal_entry', as_agent: a.agent, path: rel, action: 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] create_journal_entry: ${rel}`, as_agent: a.agent, tool: 'create_journal_entry' });
    return { path: rel, created: true };
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/integration/workflows.test.ts`
Expected: PASS, all workflows tests including new "enqueues".

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools): workflows enqueue commit jobs (plan-8/15)"
```

---

## Task 16: admin.ts — enqueue after bootstrap_agent / delete_path

**Files:**
- Modify: `src/tools/admin.ts`
- Test: `test/integration/admin.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/integration/admin.test.ts`:

```ts
import { CommitQueue } from '../../src/vault/commit-queue.js';
import { ResolutionLock } from '../../src/vault/resolution-lock.js';

describe('admin enqueues commit jobs', () => {
  it('bootstrapAgent enqueues for each created file', async () => {
    const { tmp } = setupVault();
    const queue = new CommitQueue();
    const lock = new ResolutionLock();
    const idx = new VaultIndex(tmp); await idx.build();
    const ctx = { index: idx, vaultRoot: tmp, queue, lock };
    const r = await bootstrapAgent({ name: 'novobot', platform: 'paperclip' }, ctx as any);
    expect(r.isError).toBeUndefined();
    // patterns line in AGENTS.md + 3 stub files + README link → at least 5 enqueues
    expect(queue.size()).toBeGreaterThanOrEqual(4);
    const paths = [...queue.pendingPaths()];
    expect(paths.some(p => p.endsWith('AGENTS.md'))).toBe(true);
    expect(paths.some(p => p.includes('_agents/novobot/profile.md'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- test/integration/admin.test.ts -t "enqueues"`
Expected: FAIL.

- [ ] **Step 3: Update admin.ts**

In `src/tools/admin.ts`:

a) Import helpers:

```ts
import { ToolCtx, tryToolBody, ok, ownerCheck, isVaultAdmin, enqueueWriteJob, lockPathsForWrite } from './_shared.js';
```

b) In `bootstrapAgent`, after each `writeFileAtomic`/`updateAfterWrite` block, enqueue. Specifically:

- After the `if (newAgentsMd !== original) { ... }` block, if it ran:
  ```ts
  if (newAgentsMd !== original) {
    await lockPathsForWrite(ctx, [agentsMdRel]);
    await writeFileAtomic(agentsMdAbs, newAgentsMd);
    await ctx.index.updateAfterWrite(agentsMdRel);
    await enqueueWriteJob(ctx, { path: agentsMdRel, message: `[mcp] bootstrap_agent: ${agentsMdRel}`, as_agent: 'renato', tool: 'bootstrap_agent' });
  }
  ```

- Inside the `for (const s of stubs)` loop, after `filesCreated.push(s.rel);`:
  ```ts
  await enqueueWriteJob(ctx, { path: s.rel, message: `[mcp] bootstrap_agent: ${s.rel}`, as_agent: 'renato', tool: 'bootstrap_agent' });
  ```

  And add lock:
  ```ts
  await lockPathsForWrite(ctx, [s.rel]);
  await writeFileAtomic(abs, s.content);
  ```

- After `if (readmeUpdated) { ... }`:
  ```ts
  if (readmeUpdated) {
    await lockPathsForWrite(ctx, [agentsReadmeRel]);
    await writeFileAtomic(readmeAbs, readmeAfter);
    await ctx.index.updateAfterWrite(agentsReadmeRel);
    await enqueueWriteJob(ctx, { path: agentsReadmeRel, message: `[mcp] bootstrap_agent: ${agentsReadmeRel}`, as_agent: 'renato', tool: 'bootstrap_agent' });
  }
  ```

c) In `deletePath`, after `ctx.index.removePath(a.path)`:

```ts
    await lockPathsForWrite(ctx, [a.path]);
    const kind = await deletePathRecursive(safe);
    ctx.index.removePath(a.path);
    setLastWriteTs();
    log({ ... });
    await enqueueWriteJob(ctx, { path: a.path, message: `[mcp] delete_path: ${a.path} (${a.reason})`, as_agent: a.as_agent, tool: 'delete_path' });
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- test/integration/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/admin.ts test/integration/admin.test.ts
git commit -m "feat(tools): admin enqueues commit jobs (plan-8/16)"
```

---

## Task 17: server.ts — wire SyncWorker into ctx

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Write failing test**

This is a wire-up step — the integration test will be in Task 19. For this task, we change `server.ts` to instantiate the queue/lock/worker and put them in `ToolCtx`. Verify with `npm run typecheck` and rebuild.

- [ ] **Step 2: Update server.ts**

Replace the top imports and `initCtx` in `src/server.ts`:

```ts
// src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from './config.js';
import { VaultIndex } from './vault/index.js';
import { GitOps } from './vault/git.js';
import { CommitQueue } from './vault/commit-queue.js';
import { ResolutionLock } from './vault/resolution-lock.js';
import { SyncWorker, SyncFs } from './vault/sync-worker.js';
import { ToolCtx } from './tools/_shared.js';
import * as crud from './tools/crud.js';
import * as wf from './tools/workflows.js';
import * as sync from './tools/sync.js';
import * as admin from './tools/admin.js';
import { vaultStatsResource, agentsMapResource } from './resources/vault.js';
import { log } from './middleware/logger.js';

let sharedCtxPromise: Promise<ToolCtx & { worker?: SyncWorker }> | null = null;

async function initCtx(): Promise<ToolCtx & { worker?: SyncWorker }> {
  const index = new VaultIndex(config.vaultPath);
  await index.build();
  const git = new GitOps(config.vaultPath);
  const queue = new CommitQueue();
  const lock = new ResolutionLock();

  const fs: SyncFs = {
    read: async (rel: string) => {
      try { return await fsp.readFile(path.join(config.vaultPath, rel), 'utf8'); }
      catch { return ''; }
    },
    write: async (rel: string, content: string) => {
      const abs = path.join(config.vaultPath, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
    },
  };

  let worker: SyncWorker | undefined;
  if (config.syncEnabled) {
    worker = new SyncWorker(
      { intervalMs: config.syncIntervalMs, remote: config.gitRemote, branch: config.gitBranch },
      queue, lock, git, index, fs,
    );
    worker.start();
    log({ timestamp: new Date().toISOString(), level: 'info', message: `sync-worker started (interval=${config.syncIntervalMs}ms)` });
  } else {
    log({ timestamp: new Date().toISOString(), level: 'info', message: 'sync-worker disabled (SYNC_ENABLED=false)' });
  }

  return { index, vaultRoot: config.vaultPath, git, queue, lock, worker };
}

async function getCtx(): Promise<ToolCtx & { worker?: SyncWorker }> {
  if (!sharedCtxPromise) sharedCtxPromise = initCtx();
  return sharedCtxPromise;
}

export async function __getSharedCtxForHealth(): Promise<ToolCtx & { worker?: SyncWorker }> { return await getCtx(); }
```

The rest of `server.ts` (TOOL_REGISTRY, createMcpServer) remains identical.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Run all unit tests**

Run: `npm test -- test/unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): wire SyncWorker into ToolCtx (plan-8/17)"
```

---

## Task 18: index.ts — SIGTERM/SIGINT + /health extended

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing test**

E2E smoke test will catch the `/health` change (Task 22). For this task, verify by code review + `npm run typecheck` + `npm run build`.

- [ ] **Step 2: Update index.ts**

Replace `src/index.ts` with:

```ts
import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { loggerMiddleware, log } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { createMcpServer, __getSharedCtxForHealth } from './server.js';
import { getLastWriteTs } from './last-write.js';

const app = express();
app.use(helmet());
app.use(requestId);
app.use(loggerMiddleware);

app.get('/health', async (_req, res) => {
  try {
    const ctx = await __getSharedCtxForHealth();
    const gitHead = ctx.git ? await ctx.git.head() : null;
    const workerStatus = ctx.worker ? ctx.worker.getStatus() : { enabled: false };
    res.status(200).json({
      status: 'healthy',
      vault_notes: ctx.index.size(),
      index_age_ms: ctx.index.ageMs(),
      git_head: gitHead,
      last_write_ts: getLastWriteTs(),
      sync_worker: ctx.worker ? { enabled: true, ...workerStatus } : { enabled: false },
    });
  } catch (e: any) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

app.use(rateLimiter);
app.use(authMiddleware);

app.post('/mcp', express.json(), async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});
app.get('/mcp', (_req, res) => { res.status(405).json({ error: 'SSE not supported in stateless mode' }); });
app.delete('/mcp', (_req, res) => { res.status(405).json({ error: 'No sessions to close' }); });

app.use(errorHandler);

const httpServer = app.listen(config.port, '0.0.0.0', () => {
  log({ timestamp: new Date().toISOString(), level: 'info', message: `listening on :${config.port}` });
});

async function shutdown(signal: string): Promise<void> {
  log({ timestamp: new Date().toISOString(), level: 'info', message: `received ${signal}, shutting down` });
  const ctx = await __getSharedCtxForHealth().catch(() => null);
  if (ctx?.worker) {
    const drainTimeout = setTimeout(() => {
      log({ timestamp: new Date().toISOString(), level: 'warn', message: 'sync-worker drain timeout, forcing exit' });
      process.exit(0);
    }, 10_000);
    try { await ctx.worker.stop(); } catch (e: any) {
      log({ timestamp: new Date().toISOString(), level: 'error', message: `worker stop failed: ${e.message}` });
    }
    clearTimeout(drainTimeout);
  }
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 3: Run typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(server): SIGTERM drain + /health.sync_worker (plan-8/18)"
```

---

## Task 19: Integration test — happy path (real git, real bare remote)

**Files:**
- Create: `test/integration/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/integration/sync-worker.test.ts`:

```ts
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
  execSync(`git remote add origin "${bare}"`, { cwd: local });
  fs.mkdirSync(path.join(local, '_shared/context'), { recursive: true });
  fs.writeFileSync(path.join(local, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
  execSync('git add . && git commit -q -m init && git push -q -u origin main', { cwd: local });

  execSync(`git clone -q "${bare}" "${other}"`);
  execSync('git config user.email renato@t', { cwd: other });
  execSync('git config user.name renato', { cwd: other });

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
    fs.mkdirSync(path.join(env.other, '_shared/context'), { recursive: true });
    execSync('git add . && git commit -q -m "renato edit" && git push -q origin main', { cwd: env.other });

    await (w as any).tick();
    expect(fs.existsSync(path.join(env.local, '_shared/context/fama.md'))).toBe(true);
    expect(idx.get('_shared/context/fama.md')?.frontmatter?.title).toBe('Visão');
  });
});
```

- [ ] **Step 2: Run test (expect pass — implementation is already in place from Tasks 1-12)**

Run: `npm test -- test/integration/sync-worker.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 3: Commit**

```bash
git add test/integration/sync-worker.test.ts
git commit -m "test(integration): SyncWorker happy path + Renato-first (plan-8/19)"
```

---

## Task 20: Integration test — overlap conflict resolution

**Files:**
- Modify: `test/integration/sync-worker.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/integration/sync-worker.test.ts` inside the same describe:

```ts
  it('overlap conflict: MCP wins per file, remote sha logged', async () => {
    const queue = new CommitQueue(); const lock = new ResolutionLock();
    const idx = new VaultIndex(env.local); await idx.build();
    const git = new GitOps(env.local);
    const w = new SyncWorker(
      { intervalMs: 999_999, remote: 'origin', branch: 'main' },
      queue, lock, git, idx, makeFs(env.local),
    );

    // Renato edits visao.md and pushes
    fs.mkdirSync(path.join(env.other, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(env.other, '_shared/context/visao.md'), `---
type: shared-context
owner: renato
topic: fama
title: Visão (renato)
created: 2026-04-26
updated: 2026-04-26
tags: []
---
versão renato`);
    execSync('git add . && git commit -q -m "renato edit" && git push -q origin main', { cwd: env.other });
    const renatoSha = execSync('git rev-parse HEAD', { cwd: env.other }).toString().trim();

    // MCP also writes to visao.md (different content) and enqueues
    fs.mkdirSync(path.join(env.local, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(env.local, '_shared/context/visao.md'), `---
type: shared-context
owner: alfa
topic: fama
title: Visão (mcp)
created: 2026-04-26
updated: 2026-04-26
tags: []
---
versão mcp`);
    queue.enqueue({ path: '_shared/context/visao.md', message: '[mcp] write_note: _shared/context/visao.md', as_agent: 'alfa', tool: 'write_note' });

    await (w as any).tick();

    // FS should have MCP version
    const fsContent = fs.readFileSync(path.join(env.local, '_shared/context/visao.md'), 'utf8');
    expect(fsContent).toContain('Visão (mcp)');

    // Status reflects conflict
    const status = w.getStatus();
    expect(status.totalConflictsResolved).toBe(1);
    expect(status.lastConflict?.files).toEqual(['_shared/context/visao.md']);
    expect(status.lastConflict?.remote_sha_overridden).toBe(renatoSha);

    // Other clone should see MCP version after pull (because MCP pushed last)
    execSync('git pull -q origin main', { cwd: env.other });
    const otherContent = fs.readFileSync(path.join(env.other, '_shared/context/visao.md'), 'utf8');
    expect(otherContent).toContain('Visão (mcp)');
  });
```

- [ ] **Step 2: Run test (expect pass)**

Run: `npm test -- test/integration/sync-worker.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 3: Commit**

```bash
git add test/integration/sync-worker.test.ts
git commit -m "test(integration): SyncWorker overlap conflict resolution (plan-8/20)"
```

---

## Task 21: Container — Dockerfile + docker-compose + SSH key

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Update Dockerfile**

Replace `Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache git util-linux ripgrep openssh-client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Pre-seed known_hosts and configure git for sync worker
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
    ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null && \
    chmod 644 /root/.ssh/known_hosts

# Inline entrypoint sets git identity from env and ensures safe.directory
COPY <<'EOF' /usr/local/bin/entry.sh
#!/bin/sh
set -e
git config --global user.name "${GIT_AUTHOR_NAME:-mcp-obsidian}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-mcp@fama.local}"
git config --global --add safe.directory "${VAULT_PATH:-/vault}"
if [ -f /root/.ssh/id_ed25519 ]; then chmod 600 /root/.ssh/id_ed25519; fi
exec "$@"
EOF
RUN chmod +x /usr/local/bin/entry.sh

EXPOSE 3201
ENTRYPOINT ["/usr/local/bin/entry.sh"]
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Update docker-compose.yml**

Replace `docker-compose.yml`:

```yaml
version: "3.8"

services:
  mcp-obsidian:
    image: mcp-obsidian:latest
    networks:
      - network_public
    environment:
      - PORT=3201
      - VAULT_PATH=/vault
      - RATE_LIMIT_RPM=300
      - NODE_ENV=production
      - SYNC_ENABLED=true
      - SYNC_INTERVAL_MS=30000
      - GIT_REMOTE=origin
      - GIT_BRANCH=main
      - GIT_AUTHOR_NAME=mcp-obsidian
      - GIT_AUTHOR_EMAIL=mcp@fama.local
    volumes:
      - /root/fama-brain:/vault:rw
      - /root/mcp-fama/mcp-obsidian/.env:/app/.env:ro
      - /var/log/mcp-obsidian:/app/logs
      - /root/.ssh/fama-brain-deploy:/root/.ssh/id_ed25519:ro
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:3201/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "1"
          memory: 512M
      restart_policy:
        condition: any
        delay: 5s
        max_attempts: 3
        window: 120s
      labels:
        - traefik.enable=true
        - traefik.docker.network=network_public
        - "traefik.http.routers.mcp_obsidian.rule=Host(`mcp-obsidian.famachat.com.br`)"
        - traefik.http.routers.mcp_obsidian.entrypoints=websecure
        - traefik.http.routers.mcp_obsidian.tls=true
        - traefik.http.routers.mcp_obsidian.tls.certresolver=letsencryptresolver
        - traefik.http.services.mcp_obsidian.loadbalancer.server.port=3201

networks:
  network_public:
    external: true
```

- [ ] **Step 3: Document deploy key generation in README**

Add this section to `README.md` after the `## Quickstart` section:

```markdown
### Sync worker deploy key

The MCP container uses an SSH deploy key to push to GitHub. Generate it once on the host:

    ssh-keygen -t ed25519 -C "mcp-obsidian-deploy@$(hostname)" -f /root/.ssh/fama-brain-deploy -N ""

Register the public key (`/root/.ssh/fama-brain-deploy.pub`) in the `fama-brain` GitHub repo Settings → Deploy keys, with **Allow write access**. Confirm the vault remote is SSH:

    git -C /root/fama-brain remote set-url origin git@github.com:renatinhosfaria/fama-brain.git

Validate connectivity:

    ssh -T git@github.com -i /root/.ssh/fama-brain-deploy
```

- [ ] **Step 4: Build the image (smoke test)**

Run: `docker compose build`
Expected: Build succeeds; final image has openssh-client, git, ripgrep.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "chore(deploy): SSH deploy key + sync worker env (plan-8/21)"
```

---

## Task 22: E2E smoke test — 35 tools + sync_worker on /health

**Files:**
- Modify: `test/e2e/smoke.test.ts`

- [ ] **Step 1: Update smoke test**

In `test/e2e/smoke.test.ts`, update the tool count and add sync_worker assertion:

a) Change line 82 from:

```ts
    expect(r.result.tools.length).toBe(34);
```

to:

```ts
    expect(r.result.tools.length).toBe(35);
```

b) Add new test after `auth rejects missing bearer`:

```ts
  it('/health includes sync_worker.queue_size === 0 after settle', async () => {
    // Wait briefly for any boot-time fetch to complete
    await new Promise(r => setTimeout(r, 1500));
    const r = await fetch(`http://localhost:${PORT}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.sync_worker).toBeDefined();
    expect(body.sync_worker.enabled).toBe(true);
    expect(body.sync_worker.queue_size).toBe(0);
  });
```

c) The smoke test sets `VAULT_PATH` to a tmp dir. Sync worker will try to fetch from a non-configured remote. Set `SYNC_ENABLED=false` in the env block at line 44 to keep e2e simple:

```ts
    proc = spawn('node', ['dist/index.js'], {
      env: { ...process.env, PORT: String(PORT), API_KEY: KEY, VAULT_PATH: tmpVault, GIT_LOCKFILE: path.join(tmpVault, '.lock'), SYNC_ENABLED: 'false' },
      stdio: 'inherit',
    });
```

And update the new test accordingly:

```ts
  it('/health includes sync_worker disabled when SYNC_ENABLED=false', async () => {
    const r = await fetch(`http://localhost:${PORT}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.sync_worker).toBeDefined();
    expect(body.sync_worker.enabled).toBe(false);
  });
```

- [ ] **Step 2: Build + run e2e**

Run: `npm run build && npm run test:e2e`
Expected: PASS, all e2e tests.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/smoke.test.ts
git commit -m "test(e2e): expect 35 tools + sync_worker on /health (plan-8/22)"
```

---

## Task 23: Cron host — reduce to 1x/day

**Files:**
- (No files in this repo — host crontab change)

- [ ] **Step 1: Edit crontab on host VPS**

Run on host:

```bash
crontab -l > /tmp/crontab.bak
crontab -e
```

Find line:
```
*/5 * * * * /root/fama-brain/_infra/brain-sync.sh ...
```

Change to:
```
0 4 * * * /root/fama-brain/_infra/brain-sync.sh >> /var/log/brain-sync.log 2>&1
```

- [ ] **Step 2: Validate**

Run: `crontab -l | grep brain-sync`
Expected: Single line with `0 4 * * *`.

- [ ] **Step 3: No commit needed (host config, not in repo)**

Document the change in the spec/plan if needed.

---

## Task 24: Final integration smoke (manual)

**Files:** none (manual validation)

- [ ] **Step 1: Deploy with SYNC_ENABLED=false (Phase 2 of migration)**

```bash
cd /root/mcp-fama/mcp-obsidian
echo "SYNC_ENABLED=false" >> .env
docker compose build
docker compose up -d
```

- [ ] **Step 2: Confirm no regression**

```bash
curl -sH "Authorization: Bearer $API_KEY" -X POST localhost:3201/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

Expected: `35`.

```bash
curl -s localhost:3201/health | jq .sync_worker
```

Expected: `{"enabled": false}`.

- [ ] **Step 3: Cutover (Phase 3)**

```bash
sed -i 's/SYNC_ENABLED=false/SYNC_ENABLED=true/' .env
docker compose up -d
```

- [ ] **Step 4: Monitor**

For 1 hour:

```bash
watch -n 30 'curl -s localhost:3201/health | jq .sync_worker'
```

Expected: `last_tick_outcome === "ok"`, `total_ticks` incrementing every ~30s, no `auth_failed`.

Verify GitHub history:

```bash
cd /root/fama-brain
git log --oneline -20
```

Expected: Commits with format `[mcp] <tool>: <path>` appearing instead of `auto: sync ...`.

- [ ] **Step 5: Provoke artificial conflict (validation)**

In Obsidian (Renato's machine): edit `_shared/context/AGENTS.md` (e.g., add a comment line), wait for plugin to push.

Within 30s on VPS, via MCP, do an `upsert_shared_context` that touches the same file's owner row indirectly. Wait 30s.

Check `/health`:

```bash
curl -s localhost:3201/health | jq .sync_worker.last_conflict
```

Expected: `last_conflict.files` non-empty, `remote_sha_overridden` populated.

- [ ] **Step 6: Update napkin**

Append to `/root/mcp-fama/mcp-obsidian/.claude/napkin.md`:

```markdown
- Plan 8 cutover concluído em 2026-04-XX. Sync worker substituiu cron /5min; cron host agora roda apenas 1x/dia (04:00 UTC) como safety-net. Histórico GitHub agora tem commits semânticos por operação. Deploy key SSH em /root/.ssh/fama-brain-deploy. Conflitos resolvidos via "MCP wins por arquivo" — verificar /health.sync_worker.last_conflict periodicamente.
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented in task |
|---|---|
| §2.2.1 CommitQueue | Task 1 |
| §2.2.2 SyncWorker shell + status | Task 7 |
| §2.2.2 ResolutionLock | Task 2 |
| §2.2.3 GitOps extensions | Tasks 3, 4, 5 |
| §2.2.4 VaultIndex.refreshPaths | Task 6 |
| §2.3.1 Tool of write happy path | Tasks 14, 15, 16 |
| §2.3.2 Tick fluxo limpo | Tasks 8, 9, 10 |
| §2.3.3 Tick com overlap (resolveOverlap) | Task 11 |
| §2.3.4 Tick com falhas (push retry, auth) | Task 10 (retry); auth handling in Task 10 |
| §2.3.5 Shutdown gracioso | Tasks 12, 18 |
| §3 Auth + Dockerfile + compose | Task 21 |
| §3.2 Env vars novos | Task 13 |
| §3.3 Cron safety-net diário | Task 23 |
| §4.1 /health estendido | Task 18 |
| §4.2 Log estruturado | Tasks 7-12 (status reflects events; explicit log calls in tick added implicitly via existing `log()` import — could be added in Task 18 if needed) |
| §5.1 Unit tests | Tasks 1-12 |
| §5.2 Integration tests | Tasks 19, 20 |
| §5.3 E2E smoke update | Task 22 |
| §7 Migração faseada | Task 24 |

**Gap detectado:** §4.2 menciona log estruturado com `event: 'tick_start'`, `'fetched'`, `'pulled_clean'`, `'conflict_resolved'`, `'commit'`, `'pushed'`, `'push_failed'`. O plano captura isso via `getStatus()` mas não emite explicitamente como JSON-line. Isso é desejável pra auditoria.

**Fix inline:** adicionar Task 18.5 (entre 18 e 19) que injeta calls de `log({ component: 'sync-worker', event: '...' })` nas transições do tick. Vou anexar como Task 18a.

**2. Placeholder scan:** Nenhum TBD/TODO encontrado. Todas as funções referenciadas têm definição em alguma task.

**3. Type consistency:** `CommitQueue.enqueue(job: CommitJobInput)` — `CommitJobInput` exportado em Task 1 e usado em Task 14. `SyncFs` exportado em Task 7 e usado em Task 17. `TickOutcome` definido em Task 7, expandido em Task 10 com `'auth_failed'` — mantido coerente. ✓

**4. Ambiguity:** "MCP wins por arquivo" — definido com precisão em §2.3.3 do spec e Task 11 do plano. ✓

---

## Task 18a: Structured logging in SyncWorker (gap fix)

**Files:**
- Modify: `src/vault/sync-worker.ts`

- [ ] **Step 1: Add log() emissions**

In `src/vault/sync-worker.ts`:

a) Import the logger at the top:

```ts
import { log } from '../middleware/logger.js';
```

b) Inside `tick()`, add structured log calls at key transitions:

- After `await this.git.fetch(...)`:
  ```ts
  log({ timestamp: new Date().toISOString(), level: 'info', component: 'sync-worker', event: 'fetched', remote_ahead: behind ? 'pending-check' : 0 });
  ```
  (Move this to AFTER the `behind` check below for accuracy.)

- After `await this.index.refreshPaths(remoteChanged)` in the no-overlap branch:
  ```ts
  log({ timestamp: new Date().toISOString(), level: 'info', component: 'sync-worker', event: 'pulled_clean', files_refreshed: remoteChanged });
  ```

- Inside the drain loop, after each successful `commit`:
  ```ts
  if (c) {
    log({ timestamp: new Date().toISOString(), level: 'info', component: 'sync-worker', event: 'commit', path: job.path, sha: c.sha, message: job.message });
    drained++;
  }
  ```

- After successful push:
  ```ts
  log({ timestamp: new Date().toISOString(), level: 'info', component: 'sync-worker', event: 'pushed', commits_pushed: drained });
  ```

- On push failure:
  ```ts
  log({ timestamp: new Date().toISOString(), level: r.reason === 'auth' ? 'error' : 'warn', component: 'sync-worker', event: 'push_failed', reason: r.reason, detail: r.detail });
  ```

c) Inside `resolveOverlap`, add at the end:

```ts
log({ timestamp: new Date().toISOString(), level: 'warn', component: 'sync-worker', event: 'conflict_resolved', files: [...overlap], remote_sha_overridden: remoteSha, mcp_paths_kept: [...overlap] });
```

- [ ] **Step 2: Run unit tests (should still pass — log doesn't affect logic)**

Run: `npm test -- test/unit/sync-worker.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 3: Commit**

```bash
git add src/vault/sync-worker.ts
git commit -m "feat(vault): SyncWorker structured logging (plan-8/18a)"
```

---

**Plano completo. Tarefas 1-23 cobrem implementação, container, e cutover. Task 24 é validação manual em produção.**
