import { simpleGit, SimpleGit } from 'simple-git';
import lockfile from 'proper-lockfile';
import { McpError } from '../errors.js';
import { promises as fsp } from 'node:fs';

export interface CommitResult { sha: string; branch: string; pushed: boolean; }
export interface StatusResult { modified: string[]; untracked: string[]; ahead: number; behind: number; }

export class GitOps {
  private git: SimpleGit;
  constructor(
    private readonly cwd: string,
    private readonly lockfilePath: string,
    private readonly authorName: string,
    private readonly authorEmail: string,
  ) {
    this.git = simpleGit(cwd);
  }

  async status(): Promise<StatusResult> {
    try {
      const s = await this.git.status();
      return {
        modified: [...s.modified, ...s.renamed.map(r => r.to)],
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

  async commitAndPush(message: string): Promise<CommitResult> {
    let release: (() => Promise<void>) | null = null;
    try {
      // Early-exit check BEFORE creating the lockfile sentinel (which would be an untracked file)
      const preCheck = await this.git.status();
      const hasWorkingChanges =
        preCheck.modified.length > 0 ||
        preCheck.not_added.length > 0 ||
        preCheck.deleted.length > 0 ||
        preCheck.renamed.length > 0 ||
        preCheck.staged.length > 0 ||
        preCheck.created.length > 0;

      if (!hasWorkingChanges) {
        return { sha: '', branch: preCheck.current ?? 'main', pushed: false };
      }

      // Ensure the lockfile target exists before locking (proper-lockfile requires it)
      try { await fsp.access(this.lockfilePath); }
      catch { await fsp.writeFile(this.lockfilePath, ''); }

      try {
        release = await lockfile.lock(this.lockfilePath, {
          retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
          realpath: false,
        });
      } catch (e: any) {
        throw new McpError('GIT_LOCK_BUSY', `Could not acquire lock at ${this.lockfilePath}: ${e.message}`);
      }

      await this.git.addConfig('user.name', this.authorName, false, 'local');
      await this.git.addConfig('user.email', this.authorEmail, false, 'local');

      await this.git.add('.');
      const status = await this.git.status();
      const hasChanges = status.staged.length > 0 || status.created.length > 0 || status.renamed.length > 0 || status.deleted.length > 0;
      if (!hasChanges) {
        return { sha: '', branch: status.current ?? 'main', pushed: false };
      }
      await this.git.commit(`[mcp-obsidian] ${message}`);
      const sha = (await this.git.revparse(['HEAD'])).trim();
      const branch = (await this.git.branch()).current;

      let pushed = false;
      try {
        const remotes = await this.git.getRemotes(true);
        if (remotes.length > 0) {
          await this.git.push();
          pushed = true;
        }
      } catch (e: any) {
        throw new McpError('GIT_PUSH_FAILED', `push failed: ${e.message}`);
      }
      return { sha, branch, pushed };
    } finally {
      if (release) {
        try { await release(); } catch { /* already released */ }
      }
    }
  }
}
