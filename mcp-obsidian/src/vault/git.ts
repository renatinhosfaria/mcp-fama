import { simpleGit, SimpleGit } from 'simple-git';
import { McpError } from '../errors.js';

export interface StatusResult { modified: string[]; untracked: string[]; ahead: number; behind: number; }

export class GitOps {
  private git: SimpleGit;
  constructor(cwd: string) {
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

  async fetch(remote: string, branch: string): Promise<void> {
    await this.git.fetch(remote, branch);
  }

  async isLocalBehind(remote: string, branch: string): Promise<boolean> {
    const out = await this.git.raw(['rev-list', '--count', `HEAD..${remote}/${branch}`]);
    return parseInt(out.trim(), 10) > 0;
  }

  async diffNames(from: string, to: string): Promise<string[]> {
    const out = await this.git.raw(['diff', '--name-only', `${from}..${to}`]);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  }

  /** Returns files touched in commits reachable from `to` but not from `from` (commit-range, not tree diff). */
  async logNames(from: string, to: string): Promise<string[]> {
    const out = await this.git.raw(['log', '--name-only', '--pretty=format:', `${from}..${to}`]);
    return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))];
  }

  async pullRebase(remote: string, branch: string): Promise<void> {
    await this.git.raw(['pull', '--rebase', '--autostash', remote, branch]);
  }

  async rebaseAbort(): Promise<void> {
    try { await this.git.raw(['rebase', '--abort']); }
    catch { /* nothing to abort */ }
  }

  async resetHard(ref: string): Promise<void> {
    await this.git.raw(['reset', '--hard', ref]);
  }

  async add(rel: string): Promise<void> {
    await this.git.add(rel);
  }

  async commit(message: string): Promise<{ sha: string } | null> {
    const r = await this.git.commit(message);
    if (!r.commit || r.commit === '') return null;
    return { sha: r.commit };
  }

  async push(remote: string, branch: string):
    Promise<{ ok: true } | { ok: false; reason: 'non-fast-forward' | 'network' | 'auth' | 'unknown'; detail: string }>
  {
    try {
      await this.git.push(remote, branch);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e.message ?? e);
      if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
        return { ok: false, reason: 'non-fast-forward', detail: msg };
      }
      if (/Could not resolve host|connection|timed out|network/i.test(msg)) {
        return { ok: false, reason: 'network', detail: msg };
      }
      if (/permission denied|authentication|publickey|access denied/i.test(msg)) {
        return { ok: false, reason: 'auth', detail: msg };
      }
      return { ok: false, reason: 'unknown', detail: msg };
    }
  }
}
