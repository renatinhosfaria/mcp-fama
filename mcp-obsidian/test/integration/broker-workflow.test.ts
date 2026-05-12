import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { appendBrokerInteraction, readBrokerHistory, upsertBrokerProfile } from '../../src/tools/workflows.js';
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
  for (const rel of ['_agents/alfa/broker/maria-eduarda.md']) {
    const full = path.join(FIXTURE, rel);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
  for (const p of createdFiles.splice(0)) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

async function seedBroker(rel: string, body: string, extraFrontmatter: Record<string, unknown> = {}): Promise<void> {
  const full = path.join(FIXTURE, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, serializeFrontmatter({
    type: 'entity-profile',
    owner: 'alfa',
    created: '2026-04-01',
    updated: '2026-04-01',
    tags: [],
    entity_type: 'broker',
    entity_name: 'Broker Test',
    ...extraFrontmatter,
  }, body));
  createdFiles.push(full);
  await ctx.index.updateAfterWrite(rel);
}

describe('upsert_broker_profile legacy write guard', () => {
  it('fails with LEGACY_NAMESPACE_REMOVED without creating _agents content', async () => {
    const r = await upsertBrokerProfile({
      as_agent: 'alfa',
      broker_name: 'Maria Eduarda',
      resumo: 'Broker experiente',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
    expect(fs.existsSync(path.join(FIXTURE, '_agents/alfa/broker/maria-eduarda.md'))).toBe(false);
  });
});

describe('append_broker_interaction legacy write guard', () => {
  it('fails with LEGACY_NAMESPACE_REMOVED before missing-document checks', async () => {
    const r = await appendBrokerInteraction({
      as_agent: 'alfa',
      broker_name: 'Ghost',
      channel: 'x',
      summary: 'y',
    }, ctx);

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
  });
});

describe('read_broker_history', () => {
  it('returns broker header + interactions (desc default)', async () => {
    await seedBroker('_agents/alfa/broker/ana-read-broker.md', `## Resumo
r

## Comunicação
c

## Padrões de atendimento
p

## Pendências abertas
- a
- b

## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Resumo: first

## 2026-04-11 14:15
Canal: telefone
Lead em contexto: joao
Resumo: second
`, {
      entity_name: 'Ana Read Broker',
      equipe: 'centro',
    });

    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Ana Read Broker' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.broker.entity_name).toBe('Ana Read Broker');
    expect(sc.broker.equipe).toBe('centro');
    expect(sc.broker.pendencias_abertas).toEqual(['a', 'b']);
    expect(sc.interactions.length).toBe(2);
    expect(sc.interactions[0].timestamp).toBe('2026-04-11 14:15');
    expect(sc.interactions[0].contexto_lead).toBe('joao');
    expect(sc.interactions[1].timestamp).toBe('2026-04-10 09:30');
  });

  it('MALFORMED_BROKER_BODY warnings degrade gracefully', async () => {
    await seedBroker('_agents/alfa/broker/bad-broker.md', `## Histórico de interações

## 2026-04-10 09:30
Canal: ok
Resumo: good

## garbage
broken
`, { entity_name: 'Bad Broker' });

    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Bad Broker' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.warnings[0].code).toBe('MALFORMED_BROKER_BODY');
  });

  it('BROKER_NOT_FOUND when missing', async () => {
    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Ghost B' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('BROKER_NOT_FOUND');
  });
});
