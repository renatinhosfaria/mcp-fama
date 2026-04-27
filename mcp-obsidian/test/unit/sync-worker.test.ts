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
