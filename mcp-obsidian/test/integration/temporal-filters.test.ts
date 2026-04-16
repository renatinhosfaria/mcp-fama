import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { listFolder, searchContent } from '../../src/tools/crud.js';
import { searchByTag, searchByType } from '../../src/tools/workflows.js';

describe('temporal filters across tools', () => {
  let tmp: string; let ctx: any;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-temp-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
    fs.mkdirSync(path.join(tmp, '_agents/alfa'), { recursive: true });
    // Old note (forced mtime 2026-01-01)
    const oldPath = path.join(tmp, '_agents/alfa/old.md');
    fs.writeFileSync(oldPath, `---
type: journal
owner: alfa
created: 2026-01-01
updated: 2026-01-01
tags: [foo]
---
old content with keyword banana`);
    fs.utimesSync(oldPath, new Date('2026-01-01'), new Date('2026-01-01'));
    // New note (current mtime)
    const newPath = path.join(tmp, '_agents/alfa/new.md');
    fs.writeFileSync(newPath, `---
type: journal
owner: alfa
created: 2026-04-16
updated: 2026-04-16
tags: [foo]
---
new content with keyword banana`);

    const index = new VaultIndex(tmp); await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('list_folder with since filters old entries', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, since: '2026-03-01T00:00:00Z' }, ctx);
    const items = (r.structuredContent as any).items;
    expect(items.map((i: any) => i.path)).toContain('_agents/alfa/new.md');
    expect(items.map((i: any) => i.path)).not.toContain('_agents/alfa/old.md');
  });

  it('list_folder with until filters new entries', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, until: '2026-02-01T00:00:00Z' }, ctx);
    const items = (r.structuredContent as any).items;
    expect(items.map((i: any) => i.path)).toContain('_agents/alfa/old.md');
    expect(items.map((i: any) => i.path)).not.toContain('_agents/alfa/new.md');
  });

  it('list_folder rejects since > until', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, since: '2026-06-01T00:00:00Z', until: '2026-01-01T00:00:00Z' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_TIME_RANGE');
  });

  it('list_folder rejects malformed since', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, since: 'not-a-date' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_TIME_RANGE');
  });

  it('search_by_tag filters by since', async () => {
    const r = await searchByTag({ tag: 'foo', since: '2026-03-01T00:00:00Z' }, ctx);
    const notes = (r.structuredContent as any).notes;
    expect(notes.map((n: any) => n.path)).toContain('_agents/alfa/new.md');
    expect(notes.map((n: any) => n.path)).not.toContain('_agents/alfa/old.md');
  });

  it('search_by_type filters by until', async () => {
    const r = await searchByType({ type: 'journal', until: '2026-02-01T00:00:00Z' }, ctx);
    const notes = (r.structuredContent as any).notes;
    expect(notes.map((n: any) => n.path)).toContain('_agents/alfa/old.md');
    expect(notes.map((n: any) => n.path)).not.toContain('_agents/alfa/new.md');
  });

  it('search_content filters by since (post-ripgrep filter via mtime)', async () => {
    const r = await searchContent({ query: 'banana', since: '2026-03-01T00:00:00Z' }, ctx);
    const matches = (r.structuredContent as any).matches;
    expect(matches.map((m: any) => m.path)).toContain('_agents/alfa/new.md');
    expect(matches.map((m: any) => m.path)).not.toContain('_agents/alfa/old.md');
  });
});
