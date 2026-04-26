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
}
