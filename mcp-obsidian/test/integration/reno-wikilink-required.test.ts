import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';
import { writeNote } from '../../src/tools/crud.js';
import {
  createJournalEvent,
  createOrUpdateEntity,
  recordDecision,
  upsertRunbook,
  validateVault,
} from '../../src/tools/workflows.js';

let root: string;
let ctx: { index: VaultIndex; vaultRoot: string };

function writeVaultFile(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function buildCtx(): Promise<void> {
  const index = new VaultIndex(root);
  await index.build();
  ctx = { index, vaultRoot: root };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reno-wikilink-required-'));
  writeVaultFile('_shared/context/AGENTS.md', `---
type: agents-map
owner: renato
created: 2026-05-10
updated: 2026-05-10
tags: []
---
\`\`\`
_journal/reno/** => reno
_journal/alfa/** => alfa
_decisions/*-reno-*.md => reno
_entities/** => reno
_runbooks/reno-*.md => reno
_hubs/** => renato
\`\`\`
`);
  writeVaultFile('_hubs/reno-hub.md', `---
schema_version: 1
type: hub
status: active
created: 2026-05-10
updated: 2026-05-10
source: human-curated
tags: []
author_agent: renato
title: Reno Hub
scope: reno
maintainer: renato
---
# Reno Hub
`);
  await buildCtx();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Reno wikilink requirement on create', () => {
  it('rejects Reno journal events without a resolved wikilink', async () => {
    const rel = '_journal/reno/2026-05-11-sem-link-reno-strict.md';

    const r = await createJournalEvent({
      agent: 'reno',
      title: 'Sem Link Reno Strict',
      content: 'Evento sem link resolvido.',
      event_date: '2026-05-11',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('WIKILINK_TARGET_MISSING');
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });

  it('accepts Reno journal events when frontmatter contains a resolved wikilink', async () => {
    const r = await createJournalEvent({
      agent: 'reno',
      title: 'Com Link Reno Hub',
      content: 'Evento com link resolvido no frontmatter.',
      event_date: '2026-05-11',
      related: ['[[reno-hub]]'],
    }, ctx);

    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).path).toBe('_journal/reno/2026-05-11-com-link-reno-hub.md');
  });

  it('rejects Reno journal events whose only wikilink points to a missing target', async () => {
    const rel = '_journal/reno/2026-05-11-link-inexistente.md';

    const r = await createJournalEvent({
      agent: 'reno',
      title: 'Link Inexistente',
      content: 'Evento para [[luciana-sousa]].',
      event_date: '2026-05-11',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('WIKILINK_TARGET_MISSING');
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });

  it('does not require wikilinks for non-Reno journal events', async () => {
    const r = await createJournalEvent({
      agent: 'alfa',
      title: 'Evento Alfa Sem Link',
      content: 'Evento sem link para outro agente.',
      event_date: '2026-05-11',
    }, ctx);

    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).path).toBe('_journal/alfa/2026-05-11-evento-alfa-sem-link.md');
  });

  it('requires a resolved wikilink when Reno creates an entity', async () => {
    const r = await createOrUpdateEntity({
      as_agent: 'reno',
      name: 'Bruno Sávio',
      entity_type: 'person',
      content: '# Bruno Sávio\n',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('WIKILINK_TARGET_MISSING');
    expect(fs.existsSync(path.join(root, '_entities/bruno-savio.md'))).toBe(false);
  });

  it('accepts Reno entity creation when related contains a resolved wikilink', async () => {
    const r = await createOrUpdateEntity({
      as_agent: 'reno',
      name: 'Bruno Sávio',
      entity_type: 'person',
      content: '# Bruno Sávio\n',
      related: ['[[reno-hub]]'],
    }, ctx);

    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).path).toBe('_entities/bruno-savio.md');
  });

  it('requires a resolved wikilink for Reno decision and runbook creation', async () => {
    const decision = await recordDecision({
      as_agent: 'reno',
      title: 'Decisao Sem Link',
      rationale: 'Decisao sem link resolvido.',
    }, ctx);
    const runbook = await upsertRunbook({
      as_agent: 'reno',
      slug: 'reno-sem-link',
      title: 'Reno Sem Link',
      content: '# Runbook sem link\n',
    }, ctx);

    expect((decision.structuredContent as any).error.code).toBe('WIKILINK_TARGET_MISSING');
    expect((runbook.structuredContent as any).error.code).toBe('WIKILINK_TARGET_MISSING');
  });

  it('requires a resolved wikilink for generic Reno Schema v1 creation through write_note', async () => {
    const rel = '_entities/generic-reno.md';

    const r = await writeNote({
      path: rel,
      content: '# Generic Reno\n',
      frontmatter: {
        schema_version: 1,
        type: 'entity',
        status: 'active',
        created: '2026-05-11',
        updated: '2026-05-11',
        source: 'agent-generated',
        author_agent: 'reno',
        tags: [],
        name: 'Generic Reno',
        entity_type: 'person',
      },
      as_agent: 'reno',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('WIKILINK_TARGET_MISSING');
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });
});

describe('Reno wikilink validation diagnostics', () => {
  it('reports wikilink_required findings for existing Reno Schema v1 notes without resolved wikilinks', async () => {
    const rel = '_journal/reno/2026-05-11-legado-sem-link.md';
    writeVaultFile(rel, `---
schema_version: 1
type: journal
status: active
created: 2026-05-11
updated: 2026-05-11
source: agent-generated
author_agent: reno
tags: []
title: Legado Sem Link
event_date: 2026-05-11
---
Evento antigo sem link.
`);
    await ctx.index.updateAfterWrite(rel);

    const r = await validateVault({}, ctx);
    const sc = r.structuredContent as any;

    expect(sc.categories).toContain('wikilink_required');
    expect(sc.counts.wikilink_required).toBe(1);
    expect(sc.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'wikilink_required',
        path: rel,
      }),
    ]));
  });
});
