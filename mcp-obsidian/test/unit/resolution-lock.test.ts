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
