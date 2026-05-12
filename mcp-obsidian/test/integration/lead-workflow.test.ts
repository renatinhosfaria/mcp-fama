import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { appendLeadInteraction, readLeadHistory, upsertLeadTimeline } from '../../src/tools/workflows.js';
import { serializeFrontmatter } from '../../src/vault/frontmatter.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

const createdFiles: string[] = [];
afterEach(() => {
  for (const rel of ['_agents/alfa/lead/joao-silva.md']) {
    const full = path.join(FIXTURE, rel);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
  for (const p of createdFiles.splice(0)) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

async function seedLead(rel: string, body: string, extraFrontmatter: Record<string, unknown> = {}): Promise<void> {
  const full = path.join(FIXTURE, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, serializeFrontmatter({
    type: 'entity-profile',
    owner: 'alfa',
    created: '2026-04-01',
    updated: '2026-04-01',
    tags: [],
    entity_type: 'lead',
    entity_name: 'Lead Test',
    ...extraFrontmatter,
  }, body));
  createdFiles.push(full);
  await ctx.index.updateAfterWrite(rel);
}

describe('upsert_lead_timeline legacy write guard', () => {
  it('fails with LEGACY_NAMESPACE_REMOVED without creating _agents content', async () => {
    const r = await upsertLeadTimeline({
      as_agent: 'alfa',
      lead_name: 'João Silva',
      resumo: 'Interessado em 2 dormitórios',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
    expect(fs.existsSync(path.join(FIXTURE, '_agents/alfa/lead/joao-silva.md'))).toBe(false);
  });
});

describe('append_lead_interaction legacy write guard', () => {
  it('fails with LEGACY_NAMESPACE_REMOVED before missing-document checks', async () => {
    const r = await appendLeadInteraction({
      as_agent: 'alfa',
      lead_name: 'Nonexistent',
      channel: 'x',
      summary: 'y',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
  });
});

describe('read_lead_history', () => {
  it('returns lead header + interactions parsed structurally', async () => {
    await seedLead('_agents/alfa/lead/ana-read.md', `## Resumo
r

## Interesse atual
i

## Objeções ativas
- a
- b

## Próximo passo
p

## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Resumo: primeiro

## 2026-04-11 14:15
Canal: telefone
Resumo: segundo
Objeção: entrada
Próximo passo: enviar sim
`, {
      entity_name: 'Ana Read',
      status_comercial: 'negociando',
    });

    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Ana Read' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.lead.entity_name).toBe('Ana Read');
    expect(sc.lead.status_comercial).toBe('negociando');
    expect(sc.lead.objecoes_ativas).toEqual(['a', 'b']);
    expect(sc.interactions.length).toBe(2);
    expect(sc.interactions[0].timestamp).toBe('2026-04-11 14:15');
    expect(sc.interactions[1].timestamp).toBe('2026-04-10 09:30');
    expect(sc.interactions[0].objection).toBe('entrada');
  });

  it('since filters out older interactions', async () => {
    await seedLead('_agents/alfa/lead/dani-since.md', `## Histórico de interações

## 2026-04-01 00:00
Canal: x
Resumo: old

## 2026-04-15 00:00
Canal: x
Resumo: recent
`, { entity_name: 'Dani Since' });

    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Dani Since', since: '2026-04-10T00:00:00Z' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.interactions[0].summary).toBe('recent');
  });

  it('MALFORMED_LEAD_BODY warning yields interactions minus the bad block', async () => {
    await seedLead('_agents/alfa/lead/edu-bad.md', `## Histórico de interações

## 2026-04-10 09:30
Canal: ok
Resumo: good

## not a timestamp
garbage
`, { entity_name: 'Edu Bad' });

    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Edu Bad' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.warnings).toBeDefined();
    expect(sc.warnings[0].code).toBe('MALFORMED_LEAD_BODY');
  });

  it('LEAD_NOT_FOUND when lead missing', async () => {
    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Ghost' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEAD_NOT_FOUND');
  });
});
