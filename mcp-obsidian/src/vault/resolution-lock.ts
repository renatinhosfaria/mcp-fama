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
