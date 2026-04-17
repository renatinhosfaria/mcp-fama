import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { upsertBrokerProfile, appendBrokerInteraction, readBrokerHistory } from '../../src/tools/workflows.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

const createdFiles: string[] = [];
afterEach(() => {
  for (const p of createdFiles.splice(0)) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const dir = path.dirname(p);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
});

describe('upsert_broker_profile', () => {
  it('creates _agents/<as_agent>/broker/<slug>.md with 5 sections', async () => {
    const r = await upsertBrokerProfile({
      as_agent: 'alfa',
      broker_name: 'Maria Eduarda',
      resumo: 'Broker experiente, 3 anos',
      comunicacao: 'WhatsApp funcional',
      padroes_atendimento: 'Escuta ativa primeiro',
      pendencias_abertas: ['retornar Union Vista'],
      equipe: 'centro',
      nivel_engajamento: 'ativo',
    }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_agents/alfa/broker/maria-eduarda.md');
    const full = path.join(FIXTURE, sc.path);
    createdFiles.push(full);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/type: entity-profile/);
    expect(content).toMatch(/entity_type: broker/);
    expect(content).toMatch(/equipe: centro/);
    expect(content).toMatch(/## Resumo/);
    expect(content).toMatch(/## Comunicação/);
    expect(content).toMatch(/## Padrões de atendimento/);
    expect(content).toMatch(/## Pendências abertas/);
    expect(content).toMatch(/## Histórico de interações/);
  });

  it('update preserves Histórico and merges only passed fields', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Test Update', resumo: 'orig', comunicacao: 'orig c' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/test-update.md');
    createdFiles.push(full);
    const before = fs.readFileSync(full, 'utf8');
    const withHistory = before.replace(
      '## Histórico de interações',
      '## Histórico de interações\n\n## 2026-04-10 10:00\nCanal: whatsapp\nResumo: contato inicial'
    );
    fs.writeFileSync(full, withHistory);
    await ctx.index.updateAfterWrite('_agents/alfa/broker/test-update.md');
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Test Update', comunicacao: 'atualizado' }, ctx);
    const after = fs.readFileSync(full, 'utf8');
    expect(after).toMatch(/## Resumo\s*\n\s*orig/);
    expect(after).toMatch(/## Comunicação\s*\n\s*atualizado/);
    expect(after).toMatch(/## 2026-04-10 10:00/);
    expect(after).toMatch(/contato inicial/);
  });
});

describe('append_broker_interaction', () => {
  it('appends a block with broker-specific fields', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Carlos Broker', resumo: 'test append' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/carlos-broker.md');
    createdFiles.push(full);

    const r = await appendBrokerInteraction({
      as_agent: 'alfa', broker_name: 'Carlos Broker',
      channel: 'whatsapp', summary: '1:1 semanal',
      contexto_lead: 'joao-silva', dificuldade: 'leads frios',
      encaminhamento: 'testar nova abordagem',
      tags: ['#broker-ativo'],
      timestamp: '2026-04-10T09:30:00Z',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).bytes_appended).toBeGreaterThan(0);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/## 2026-04-10 09:30/);
    expect(content).toMatch(/Canal: whatsapp/);
    expect(content).toMatch(/Lead em contexto: joao-silva/);
    expect(content).toMatch(/Dificuldade: leads frios/);
    expect(content).toMatch(/Encaminhamento: testar nova/);
    expect(content).toMatch(/Tags: #broker-ativo/);
  });

  it('BROKER_NOT_FOUND when broker doc does not exist', async () => {
    const r = await appendBrokerInteraction({
      as_agent: 'alfa', broker_name: 'Ghost', channel: 'x', summary: 'y',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('BROKER_NOT_FOUND');
  });

  it('contexto_lead is optional', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'No Context', resumo: 'x' }, ctx);
    createdFiles.push(path.join(FIXTURE, '_agents/alfa/broker/no-context.md'));
    const r = await appendBrokerInteraction({
      as_agent: 'alfa', broker_name: 'No Context',
      channel: 'telefone', summary: 'sem lead em contexto',
    }, ctx);
    expect(r.isError).toBeUndefined();
  });
});

describe('read_broker_history', () => {
  it('returns broker header + interactions (desc default)', async () => {
    await upsertBrokerProfile({
      as_agent: 'alfa', broker_name: 'Ana Read Broker',
      resumo: 'r', comunicacao: 'c', padroes_atendimento: 'p',
      pendencias_abertas: ['a', 'b'],
      equipe: 'centro', nivel_engajamento: 'ativo',
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/ana-read-broker.md');
    createdFiles.push(full);

    await appendBrokerInteraction({ as_agent: 'alfa', broker_name: 'Ana Read Broker', channel: 'whatsapp', summary: 'first', timestamp: '2026-04-10T09:30:00Z' }, ctx);
    await appendBrokerInteraction({ as_agent: 'alfa', broker_name: 'Ana Read Broker', channel: 'telefone', summary: 'second', contexto_lead: 'joao', timestamp: '2026-04-11T14:15:00Z' }, ctx);

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

  it('BROKER_NOT_FOUND when missing', async () => {
    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Ghost B' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('BROKER_NOT_FOUND');
  });

  it('MALFORMED_BROKER_BODY warnings degrade gracefully', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Bad Broker', resumo: 'x' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/bad-broker.md');
    createdFiles.push(full);
    const cur = fs.readFileSync(full, 'utf8');
    const corrupted = cur.replace(
      '## Histórico de interações\n',
      `## Histórico de interações\n\n## 2026-04-10 09:30\nCanal: ok\nResumo: good\n\n## garbage\nbroken\n`
    );
    fs.writeFileSync(full, corrupted);
    await ctx.index.updateAfterWrite('_agents/alfa/broker/bad-broker.md');
    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Bad Broker' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.warnings[0].code).toBe('MALFORMED_BROKER_BODY');
  });

  it('Plan 7: upsert_broker_profile preserves nivel_atencao + ultima_acao_recomendada in frontmatter', async () => {
    await upsertBrokerProfile(
      {
        as_agent: 'alfa',
        broker_name: 'Maria Exec',
        resumo: 'Broker ativa',
        nivel_atencao: 'risco',
        ultima_acao_recomendada: 'agendar 1:1 sobre entrada alta',
      },
      ctx,
    );
    const full = path.join(FIXTURE, '_agents/alfa/broker/maria-exec.md');
    createdFiles.push(full);
    const r = await readBrokerHistory(
      { as_agent: 'alfa', broker_name: 'Maria Exec' },
      ctx,
    );
    const fm = (r as any).structuredContent.broker;
    expect(fm.nivel_atencao).toBe('risco');
    expect(fm.ultima_acao_recomendada).toBe('agendar 1:1 sobre entrada alta');

    // Update without passing exec fields → must preserve
    await upsertBrokerProfile(
      { as_agent: 'alfa', broker_name: 'Maria Exec', resumo: 'v2' },
      ctx,
    );
    const r2 = await readBrokerHistory(
      { as_agent: 'alfa', broker_name: 'Maria Exec' },
      ctx,
    );
    const fm2 = (r2 as any).structuredContent.broker;
    expect(fm2.nivel_atencao).toBe('risco');
    expect(fm2.ultima_acao_recomendada).toBe('agendar 1:1 sobre entrada alta');
  });

  it('Plan 7: upsert_broker_profile rejects ultima_acao_recomendada with newline', async () => {
    const full = path.join(FIXTURE, '_agents/alfa/broker/bad-broker-newline.md');
    createdFiles.push(full);
    const r = await upsertBrokerProfile(
      {
        as_agent: 'alfa',
        broker_name: 'Bad Broker Newline',
        ultima_acao_recomendada: 'line1\nline2',
      },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_FRONTMATTER');
  });
});
