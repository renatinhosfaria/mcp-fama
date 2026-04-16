import { simpleGit, SimpleGit } from 'simple-git';
import { spawn } from 'node:child_process';
import { McpError } from '../errors.js';
import { promises as fsp } from 'node:fs';

export interface CommitResult { sha: string; branch: string; pushed: boolean; }
export interface StatusResult { modified: string[]; untracked: string[]; ahead: number; behind: number; }

// Wraps a callback in an exclusive flock(1) on the given path.
// Uses the same mechanism as _infra/brain-sync.sh (flock -xn on fd 9).
async function withFlock<T>(lockPath: string, timeoutSec: number, fn: () => Promise<T>): Promise<T> {
  // Ensure the lock file exists
  try { await fsp.access(lockPath); }
  catch { await fsp.writeFile(lockPath, ''); }

  // flock -x -w <timeout> <lockfile> -c '<cmd>' only works for shell commands.
  // For Node-side callbacks we need a long-running flock-held fd. We spawn `flock -x -w ... <lockfile> sleep <N>`
  // — but that's racy. Better: use `flock -x -w ... <lockfile> bash -c 'cat >/dev/null'` and keep stdin open
  // while we work, then close stdin to release.
  return await new Promise<T>((resolve, reject) => {
    const proc = spawn('/usr/bin/flock', ['-x', '-w', String(timeoutSec), lockPath, 'bash', '-c', 'cat >/dev/null'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    // Once flock has acquired the lock, the 'bash -c "cat >/dev/null"' child starts; we can't observe that
    // readily, so assume acquired after a short ready delay OR trust flock's blocking semantics.
    // Approach: immediately start fn(); if flock couldn't acquire within timeout, the subprocess exits with
    // non-zero; we abort fn then.
    let aborted = false;
    proc.on('error', (e) => { aborted = true; reject(new McpError('GIT_LOCK_BUSY', `flock spawn failed: ${e.message}`)); });
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null && !aborted) {
        // flock itself returned non-zero because it couldn't acquire in -w timeout
        aborted = true;
        reject(new McpError('GIT_LOCK_BUSY', `Could not acquire flock(${lockPath}) within ${timeoutSec}s (exit ${code}; stderr: ${stderr.trim()})`));
      }
    });
    // Run the work, then signal flock to release by closing stdin
    (async () => {
      try {
        const result = await fn();
        if (proc.stdin && !proc.stdin.destroyed) { proc.stdin.end(); }
        resolve(result);
      } catch (e) {
        if (proc.stdin && !proc.stdin.destroyed) { proc.stdin.end(); }
        reject(e);
      }
    })();
  });
}

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
        modified: [...s.modified, ...s.renamed.map((r: any) => r.to)],
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
    // First: check if there's anything to commit — no-op case doesn't need the lock
    const preStatus = await this.git.status();
    const hasChangesBefore = preStatus.not_added.length > 0 || preStatus.modified.length > 0 || preStatus.deleted.length > 0 || preStatus.created.length > 0;
    if (!hasChangesBefore) {
      return { sha: '', branch: preStatus.current ?? 'main', pushed: false };
    }

    return await withFlock(this.lockfilePath, 3, async () => {
      // Configure author inline via env vars, not global config mutation
      await this.git.env({
        GIT_AUTHOR_NAME: this.authorName,
        GIT_AUTHOR_EMAIL: this.authorEmail,
        GIT_COMMITTER_NAME: this.authorName,
        GIT_COMMITTER_EMAIL: this.authorEmail,
      }).add('.');

      const status = await this.git.status();
      const hasChanges = status.staged.length > 0 || status.created.length > 0 || status.renamed.length > 0 || status.deleted.length > 0;
      if (!hasChanges) {
        return { sha: '', branch: status.current ?? 'main', pushed: false };
      }
      await this.git.env({
        GIT_AUTHOR_NAME: this.authorName,
        GIT_AUTHOR_EMAIL: this.authorEmail,
        GIT_COMMITTER_NAME: this.authorName,
        GIT_COMMITTER_EMAIL: this.authorEmail,
      }).commit(`[mcp-obsidian] ${message}`);
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
    });
  }
}
