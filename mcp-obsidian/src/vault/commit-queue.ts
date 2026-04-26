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
