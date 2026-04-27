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
}
