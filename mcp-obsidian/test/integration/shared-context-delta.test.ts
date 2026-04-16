// test/integration/shared-context-delta.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { getSharedContextDelta } from '../../src/tools/workflows.js';

describe('get_shared_context_delta', () => {
  let tmp: string;
  let ctx: any;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-scd-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      '```\n_shared/context/*/alfa/** => alfa\n_shared/context/*/beta/** => beta\n```',
    );

    // alfa writes 3 shared-contexts: 2 recent, 1 old
    const mkNote = (rel: string, topic: string, owner: string, mtime: Date, title = 't', body = 'body') => {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `---
type: shared-context
owner: ${owner}
created: 2026-01-01
updated: ${mtime.toISOString().slice(0, 10)}
tags: []
topic: ${topic}
title: ${title}
---
${body}`);
      fs.utimesSync(abs, mtime, mtime);
    };

    mkNote('_shared/context/opt-out/alfa/whatsapp-bloco.md', 'opt-out', 'alfa',
           new Date('2026-04-10T00:00:00Z'), 'WA block', 'Cliente pediu parar WA.');
    mkNote('_shared/context/objecoes/alfa/entrada-alta.md', 'objecoes', 'alfa',
           new Date('2026-04-12T00:00:00Z'), 'Entrada alta', 'Objecao: entrada > 20%.');
    mkNote('_shared/context/aprendizados/alfa/union-vista.md', 'aprendizados', 'alfa',
           new Date('2026-01-01T00:00:00Z'), 'Union Vista', 'Aprendizado old.');

    // beta writes 1 recent shared-context in opt-out
    mkNote('_shared/context/opt-out/beta/silencio.md', 'opt-out', 'beta',
           new Date('2026-04-14T00:00:00Z'), 'Silencio', 'Lead silenciou 3 msgs.');

    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('returns by_topic groups for shared-context entries after since', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(3); // old one excluded
    expect(Object.keys(sc.by_topic).sort()).toEqual(['objecoes', 'opt-out']);
    expect(sc.by_topic['opt-out']).toHaveLength(2);
    expect(sc.by_topic['objecoes']).toHaveLength(1);
    // Each item has required fields
    const item = sc.by_topic['opt-out'][0];
    expect(item).toHaveProperty('path');
    expect(item).toHaveProperty('owner');
    expect(item).toHaveProperty('mtime');
    expect(item).toHaveProperty('frontmatter');
    expect(item).toHaveProperty('preview');
    expect(item.preview.length).toBeLessThanOrEqual(500);
    expect(item).not.toHaveProperty('content');
  });

  it('filters by topics[]', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', topics: ['opt-out'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(2);
    expect(Object.keys(sc.by_topic)).toEqual(['opt-out']);
  });

  it('filters by owners[]', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', owners: ['beta'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(1);
    expect(sc.by_topic['opt-out'][0].owner).toBe('beta');
  });

  it('returns INVALID_OWNER for unknown owner filter', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', owners: ['ghost'] },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_OWNER');
  });

  it('include_content=true returns full content', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', topics: ['opt-out'], owners: ['beta'], include_content: true },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.by_topic['opt-out'][0].content).toContain('Lead silenciou 3 msgs.');
  });

  it('returns INVALID_TIME_RANGE for malformed since', async () => {
    const r = await getSharedContextDelta({ since: 'not-a-date' }, ctx);
    expect((r as any).structuredContent.error.code).toBe('INVALID_TIME_RANGE');
  });

  it('empty result when since is in the future', async () => {
    const r = await getSharedContextDelta({ since: '2099-01-01T00:00:00Z' }, ctx);
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(0);
    expect(sc.by_topic).toEqual({});
  });
});
