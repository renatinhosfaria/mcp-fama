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
