// test/integration/broker-operational-summary.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { getBrokerOperationalSummary } from '../../src/tools/workflows.js';
import { serializeBrokerBody, type BrokerInteraction } from '../../src/vault/broker.js';
import { serializeFrontmatter } from '../../src/vault/frontmatter.js';
import { toKebabSlug } from '../../src/vault/fs.js';

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

  async function seedBroker(
    brokerName: string,
    frontmatter: Record<string, unknown> = {},
    interactions: BrokerInteraction[] = [],
  ): Promise<void> {
    const rel = `_agents/famaagent/broker/${toKebabSlug(brokerName)}.md`;
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const pendencias = Array.isArray(frontmatter.pendencias_abertas)
      ? frontmatter.pendencias_abertas as string[]
      : null;
    const body = serializeBrokerBody({
      headers: {
        resumo: typeof frontmatter.resumo === 'string' ? frontmatter.resumo : null,
        comunicacao: null,
        padroes_atendimento: null,
        pendencias_abertas: pendencias,
      },
      interactions,
      malformed_blocks: [],
    });
    fs.writeFileSync(full, serializeFrontmatter({
      type: 'entity-profile',
      owner: 'famaagent',
      created: '2026-04-01',
      updated: '2026-04-01',
      tags: [],
      entity_type: 'broker',
      entity_name: brokerName,
      ...frontmatter,
    }, body));
    await ctx.index.updateAfterWrite(rel);
  }

  function timestampDaysAgo(daysAgo: number): string {
    const d = new Date(Date.now() - daysAgo * 86400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  function interaction(daysAgo: number, summary: string, dificuldade: string | null = null): BrokerInteraction {
    return {
      timestamp: timestampDaysAgo(daysAgo),
      channel: 'whatsapp',
      contexto_lead: null,
      summary,
      dificuldade,
      encaminhamento: null,
      tags: [],
    };
  }

  it('BROKER_NOT_FOUND when broker doc missing', async () => {
    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Ghost Broker' },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('BROKER_NOT_FOUND');
  });

  it('returns broker frontmatter + descriptive sinais_de_risco when no interactions', async () => {
    await seedBroker('Alpha Broker', {
      nivel_atencao: 'atencao',
      ultima_acao_recomendada: 'agendar 1:1',
      pendencias_abertas: ['retornar sobre X', 'confirmar agenda Y', 'validar lead Z'],
    });
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
    await seedBroker(
      'Beta Broker',
      { resumo: 'x' },
      [2, 10, 20, 35, 45].map((daysAgo) => interaction(daysAgo, `interaction ${daysAgo}d ago`)),
    );

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
    await seedBroker('Gamma Broker', { resumo: 'x' }, [
      interaction(5, 's', 'objeção entrada'),
      interaction(10, 's', 'objeção entrada'),
      interaction(15, 's', 'timing'),
    ]);

    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Gamma Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.dificuldades_repetidas).toEqual([{ dificuldade: 'objeção entrada', count: 2 }]);
  });

  it('sinais_de_risco mentions inactivity when dias_desde_ultima_interacao > 7', async () => {
    await seedBroker('Delta Broker', { resumo: 'x' }, [interaction(14, 's')]);

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
    await seedBroker(
      'Epsilon Broker',
      { resumo: 'x' },
      [1, 3, 5, 7, 9, 11, 13].map((daysAgo) => interaction(daysAgo, `s${daysAgo}`)),
    );
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
