// test/integration/broker-operational-summary.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import {
  upsertBrokerProfile,
  appendBrokerInteraction,
  getBrokerOperationalSummary,
} from '../../src/tools/workflows.js';

describe('get_broker_operational_summary', () => {
  let tmp: string;
  let ctx: any;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bos-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      '```\n_agents/famaagent/** => famaagent\n```',
    );
    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('BROKER_NOT_FOUND when broker doc missing', async () => {
    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Ghost Broker' },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('BROKER_NOT_FOUND');
  });

  it('returns broker frontmatter + descriptive sinais_de_risco when no interactions', async () => {
    await upsertBrokerProfile(
      {
        as_agent: 'famaagent',
        broker_name: 'Alpha Broker',
        nivel_atencao: 'atencao',
        ultima_acao_recomendada: 'agendar 1:1',
        pendencias_abertas: ['retornar sobre X', 'confirmar agenda Y', 'validar lead Z'],
      },
      ctx,
    );
    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Alpha Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.broker.entity_name).toBe('Alpha Broker');
    expect(sc.broker.nivel_atencao).toBe('atencao');
    expect(sc.broker.ultima_acao_recomendada).toBe('agendar 1:1');
    expect(sc.pendencias_abertas).toHaveLength(3);
    expect(sc.dias_desde_ultima_interacao).toBeNull();
    expect(sc.total_interacoes_periodo_atual).toBe(0);
    expect(sc.total_interacoes_periodo_anterior).toBe(0);
    expect(sc.dificuldades_repetidas).toEqual([]);
    // sinais_de_risco should mention pendencias count (3)
    expect(sc.sinais_de_risco.some((s: string) => s.toLowerCase().includes('3') && s.includes('pendência'))).toBe(true);
  });

  it('counts interactions in current vs previous period windows', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Beta Broker', resumo: 'x' },
      ctx,
    );

    // Build interactions: 3 in last 28 days, 2 in the prior 28-day window (days 28-56 ago)
    const mkTs = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();

    for (const daysAgo of [2, 10, 20, 35, 45]) {
      await appendBrokerInteraction(
        {
          as_agent: 'famaagent',
          broker_name: 'Beta Broker',
          channel: 'whatsapp',
          summary: `interaction ${daysAgo}d ago`,
          timestamp: mkTs(daysAgo),
        },
        ctx,
      );
    }

    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Beta Broker', periodo_tendencia_dias: 28 },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total_interacoes_periodo_atual).toBe(3);
    expect(sc.total_interacoes_periodo_anterior).toBe(2);
    expect(sc.dias_desde_ultima_interacao).toBe(2);
  });

  it('dificuldades_repetidas only surfaces counts >= 2 in current window', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Gamma Broker', resumo: 'x' },
      ctx,
    );
    const mkTs = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Gamma Broker', channel: 'whatsapp', summary: 's', dificuldade: 'objeção entrada', timestamp: mkTs(5) }, ctx);
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Gamma Broker', channel: 'whatsapp', summary: 's', dificuldade: 'objeção entrada', timestamp: mkTs(10) }, ctx);
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Gamma Broker', channel: 'whatsapp', summary: 's', dificuldade: 'timing', timestamp: mkTs(15) }, ctx);

    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Gamma Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.dificuldades_repetidas).toEqual([{ dificuldade: 'objeção entrada', count: 2 }]);
  });

  it('sinais_de_risco mentions inactivity when dias_desde_ultima_interacao > 7', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Delta Broker', resumo: 'x' },
      ctx,
    );
    const ts = new Date(Date.now() - 14 * 86400_000).toISOString();
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Delta Broker', channel: 'whatsapp', summary: 's', timestamp: ts }, ctx);

    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Delta Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.dias_desde_ultima_interacao).toBeGreaterThanOrEqual(13);
    expect(sc.dias_desde_ultima_interacao).toBeLessThanOrEqual(15);
    expect(sc.sinais_de_risco.some((s: string) => s.toLowerCase().includes('sem interação'))).toBe(true);
  });

  it('recent_interactions respects n_recent_interactions=5 default', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Epsilon Broker', resumo: 'x' },
      ctx,
    );
    const mkTs = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();
    for (const daysAgo of [1, 3, 5, 7, 9, 11, 13]) {
      await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Epsilon Broker', channel: 'whatsapp', summary: `s${daysAgo}`, timestamp: mkTs(daysAgo) }, ctx);
    }
    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Epsilon Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.recent_interactions).toHaveLength(5);
    // Most recent first
    expect(sc.recent_interactions[0].summary).toBe('s1');
  });
});
