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
          await this.resolveOverlap(remoteChanged, overlap);
          this.status.lastTickOutcome = 'conflict_resolved';
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

  private async resolveOverlap(remoteChanged: string[], overlap: string[]): Promise<void> {
    // Snapshot MCP versions BEFORE reset
    this.lock.lockPaths(overlap);
    const snapshot = new Map<string, string>();
    for (const p of overlap) snapshot.set(p, await this.fs.read(p));
    let remoteSha = '';
    try { remoteSha = (await (this.git as any).head?.()) ?? ''; } catch { remoteSha = ''; }

    try {
      await this.git.rebaseAbort();
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
}
