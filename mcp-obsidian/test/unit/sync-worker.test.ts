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
