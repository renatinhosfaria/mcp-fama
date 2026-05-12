// test/integration/brokers-needing-attention.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { listBrokersNeedingAttention } from '../../src/tools/workflows.js';
import { serializeBrokerBody } from '../../src/vault/broker.js';
import { serializeFrontmatter } from '../../src/vault/frontmatter.js';
import { toKebabSlug } from '../../src/vault/fs.js';

describe('list_brokers_needing_attention', () => {
  let tmp: string;
  let ctx: any;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lbn-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      '```\n_agents/famaagent/** => famaagent\n```',
    );
    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };

    // Brokers setup: alpha=critico 3 pendencias, beta=atencao 0 pendencias, gamma=normal, delta=risco 1 pendencia
    await seedBroker('Alpha', { equipe: 'centro', nivel_atencao: 'critico', ultima_acao_recomendada: 'ligar hoje', pendencias_abertas: ['p1', 'p2', 'p3'] });
    await seedBroker('Beta', { equipe: 'zona-sul', nivel_atencao: 'atencao', ultima_acao_recomendada: 'agendar 1:1' });
    await seedBroker('Gamma', { equipe: 'centro', nivel_atencao: 'normal' });
    await seedBroker('Delta', { equipe: 'zona-sul', nivel_atencao: 'risco', pendencias_abertas: ['p1'] });
  });

  async function seedBroker(brokerName: string, frontmatter: Record<string, unknown>): Promise<void> {
    const rel = `_agents/famaagent/broker/${toKebabSlug(brokerName)}.md`;
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const pendencias = Array.isArray(frontmatter.pendencias_abertas)
      ? frontmatter.pendencias_abertas as string[]
      : null;
    const body = serializeBrokerBody({
      headers: {
        resumo: null,
        comunicacao: null,
        padroes_atendimento: null,
        pendencias_abertas: pendencias,
      },
      interactions: [],
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

  it('default filters exclude normal + default priority order', async () => {
    const r = await listBrokersNeedingAttention({ as_agent: 'famaagent' }, ctx);
    const sc = (r as any).structuredContent;
    const names = sc.brokers.map((b: any) => b.broker_name);
    expect(names).not.toContain('Gamma'); // normal excluded
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
    expect(names).toContain('Delta');
    // Priority order: Alpha (critico+3pend = 30+9 = 39) > Delta (risco+1pend = 15+3 = 18) > Beta (atencao+0 = 5)
    expect(names[0]).toBe('Alpha');
    expect(names[names.length - 1]).toBe('Beta');
  });

  it('risk_levels filter narrows to specific levels', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', risk_levels: ['critico'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.brokers).toHaveLength(1);
    expect(sc.brokers[0].broker_name).toBe('Alpha');
  });

  it('equipes filter narrows to specific team', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', equipes: ['centro'], risk_levels: ['normal', 'atencao', 'risco', 'critico'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    const names = sc.brokers.map((b: any) => b.broker_name);
    expect(names).toEqual(expect.arrayContaining(['Alpha', 'Gamma']));
    expect(names).not.toContain('Beta');
    expect(names).not.toContain('Delta');
  });

  it('min_pendencias filter excludes brokers below threshold', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', min_pendencias: 2 },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.brokers).toHaveLength(1);
    expect(sc.brokers[0].broker_name).toBe('Alpha');
  });

  it('order=alphabetical sorts by broker_name asc', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', order: 'alphabetical' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    const names = sc.brokers.map((b: any) => b.broker_name);
    expect(names).toEqual(['Alpha', 'Beta', 'Delta']);
  });

  it('INVALID_RELATIVE_TIME for bad since', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', since: 'garbage' },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_RELATIVE_TIME');
  });

  it('returns ultima_acao_recomendada inline on each broker', async () => {
    const r = await listBrokersNeedingAttention({ as_agent: 'famaagent' }, ctx);
    const sc = (r as any).structuredContent;
    const alpha = sc.brokers.find((b: any) => b.broker_name === 'Alpha');
    expect(alpha.ultima_acao_recomendada).toBe('ligar hoje');
    expect(alpha.priority_score).toBeGreaterThan(0);
  });
});
