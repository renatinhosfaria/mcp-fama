// test/integration/stress.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { GitOps } from '../../src/vault/git.js';
import { writeNote } from '../../src/tools/crud.js';
import { parseFrontmatter } from '../../src/vault/frontmatter.js';

describe('concurrency stress', () => {
  let tmp: string; let ctx: any;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stress-'));
    execSync('git init -q -b main', { cwd: tmp });
    execSync('git config user.email "t@t"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
    execSync('git add .', { cwd: tmp });
    execSync('git commit -q -m init', { cwd: tmp });
    const index = new VaultIndex(tmp); await index.build();
    const git = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp', 'm@f');
    ctx = { index, vaultRoot: tmp, git };
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('10 parallel writes + simulated cron push → zero corruption', async () => {
    const ops = Array.from({ length: 10 }, (_, i) => writeNote({
      path: `_agents/alfa/s${i}.md`,
      content: `# ${i}`,
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx));
    const sim = ctx.git.commitAndPush('cron simulated');
    const results = await Promise.all([...ops, sim].map(p => p.catch(e => ({ error: e.message }))));
    const writeErrors = results.slice(0, 10).filter((r: any) => r?.isError === true);
    expect(writeErrors.length).toBe(0);

    // Zero corruption: every file re-parses clean
    for (let i = 0; i < 10; i++) {
      const p = path.join(tmp, `_agents/alfa/s${i}.md`);
      const content = fs.readFileSync(p, 'utf8');
      expect(() => parseFrontmatter(content)).not.toThrow();
    }
  }, 30_000);
});
