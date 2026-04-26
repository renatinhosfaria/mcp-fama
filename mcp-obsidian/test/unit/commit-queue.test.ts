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
