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
}
