import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';

const FIXTURE = path.resolve('test/fixtures/vault');

describe('VaultIndex.build', () => {
  it('indexes all .md files', async () => {
    const idx = new VaultIndex(FIXTURE);
    await idx.build();
    const paths = idx.allEntries().map(e => e.path).sort();
    expect(paths).toContain('_agents/alfa/README.md');
    expect(paths).toContain('_agents/alfa/profile.md');
    expect(paths).toContain('_agents/alfa/decisions.md');
    expect(paths).toContain('_agents/alfa/journal/2026-04-15-titulo.md');
    expect(paths).toContain('_agents/beta/profile.md');
    expect(paths).toContain('_shared/context/AGENTS.md');
  });
  it('captures owner, type, mtime, tags', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const e = idx.get('_agents/alfa/decisions.md');
    expect(e?.owner).toBe('alfa');
    expect(e?.type).toBe('agent-decisions');
    expect(e?.tags).toEqual(['decisions']);
    expect(e?.mtimeMs).toBeGreaterThan(0);
  });
  it('skips non-md', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    expect(idx.allEntries().every(e => e.path.endsWith('.md'))).toBe(true);
  });
});

describe('VaultIndex queries', () => {
  it('byTag', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const r = idx.byTag('decisions');
    expect(r.map(e => e.path)).toEqual(['_agents/alfa/decisions.md']);
  });
  it('byType', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    expect(idx.byType('agent-profile').length).toBe(2);
  });
  it('byOwner', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const alfa = idx.byOwner('alfa');
    expect(alfa.length).toBeGreaterThanOrEqual(4);
    expect(alfa.every(e => e.owner === 'alfa')).toBe(true);
  });
});

describe('VaultIndex backlinks', () => {
  it('extracts wikilinks and computes backlinks', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const readme = idx.get('_agents/alfa/README.md')!;
    expect(readme.wikilinks).toContain('../beta/profile');
    const beta = idx.backlinks('beta/profile');
    expect(beta.map(b => b.path)).toContain('_agents/alfa/README.md');
  });
});

describe('VaultIndex lazy invalidation', () => {
  it('refreshIfStale picks up new tags after external write', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const target = path.join(FIXTURE, '_agents/alfa/temp.md');
    fs.writeFileSync(target, `---\ntype: journal\nowner: alfa\ncreated: 2026-04-15\nupdated: 2026-04-15\ntags: [tempfix]\n---\n# t`);
    try {
      await idx.refreshIfStale('_agents/alfa/temp.md');
      expect(idx.byTag('tempfix').length).toBe(1);
    } finally {
      fs.unlinkSync(target);
    }
  });

  it('updateAfterWrite re-indexes a single file', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const target = path.join(FIXTURE, '_agents/alfa/temp2.md');
    fs.writeFileSync(target, `---\ntype: journal\nowner: alfa\ncreated: 2026-04-15\nupdated: 2026-04-15\ntags: [updtest]\n---\n# x`);
    try {
      await idx.updateAfterWrite('_agents/alfa/temp2.md');
      expect(idx.get('_agents/alfa/temp2.md')?.tags).toEqual(['updtest']);
    } finally {
      fs.unlinkSync(target);
    }
  });

  it('updateAfterWrite removes entry when file deleted', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const target = path.join(FIXTURE, '_agents/alfa/del.md');
    fs.writeFileSync(target, `---\ntype: journal\nowner: alfa\ncreated: 2026-04-15\nupdated: 2026-04-15\ntags: []\n---\nx`);
    await idx.updateAfterWrite('_agents/alfa/del.md');
    expect(idx.get('_agents/alfa/del.md')).toBeTruthy();
    fs.unlinkSync(target);
    await idx.updateAfterWrite('_agents/alfa/del.md');
    expect(idx.get('_agents/alfa/del.md')).toBeUndefined();
  });
});
