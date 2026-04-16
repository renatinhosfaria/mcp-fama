import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { upsertLeadTimeline, appendLeadInteraction, readLeadHistory } from '../../src/tools/workflows.js';

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

describe('upsert_lead_timeline', () => {
  it('creates _agents/<as_agent>/lead/<slug>.md with 5 sections', async () => {
    const r = await upsertLeadTimeline({
      as_agent: 'alfa',
      lead_name: 'João Silva',
      resumo: 'Interessado em 2 dormitórios',
      interesse_atual: 'Imóvel pronto até R$ 400k',
      objecoes_ativas: ['entrada alta', 'medo da parcela'],
      proximo_passo: 'Enviar simulação CEF',
      status_comercial: 'qualificando',
      origem: 'campanha-union-vista',
    }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_agents/alfa/lead/joao-silva.md');
    const full = path.join(FIXTURE, sc.path);
    createdFiles.push(full);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/type: entity-profile/);
    expect(content).toMatch(/entity_type: lead/);
    expect(content).toMatch(/status_comercial: qualificando/);
    expect(content).toMatch(/## Resumo/);
    expect(content).toMatch(/## Interesse atual/);
    expect(content).toMatch(/## Objeções ativas/);
    expect(content).toMatch(/## Próximo passo/);
    expect(content).toMatch(/## Histórico de interações/);
  });

  it('update preserves Histórico section and merges only passed fields', async () => {
    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Maria Test',
      resumo: 'original resumo',
      proximo_passo: 'original proximo',
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/maria-test.md');
    createdFiles.push(full);

    const before = fs.readFileSync(full, 'utf8');
    const withHistory = before.replace(
      '## Histórico de interações',
      '## Histórico de interações\n\n## 2026-04-10 10:00\nCanal: whatsapp\nResumo: contato inicial'
    );
    fs.writeFileSync(full, withHistory);
    await ctx.index.updateAfterWrite('_agents/alfa/lead/maria-test.md');

    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Maria Test',
      proximo_passo: 'atualizado'
    }, ctx);
    const after = fs.readFileSync(full, 'utf8');
    expect(after).toMatch(/Resumo\s*\n\s*original resumo/);
    expect(after).toMatch(/Próximo passo\s*\n\s*atualizado/);
    expect(after).toMatch(/## 2026-04-10 10:00/);
    expect(after).toMatch(/contato inicial/);
  });

  it('OWNERSHIP_VIOLATION when as_agent is wrong owner', async () => {
    const r = await upsertLeadTimeline({ as_agent: 'beta', lead_name: 'Cross Agent' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });

  it('INVALID_FILENAME when lead_name produces empty slug', async () => {
    const r = await upsertLeadTimeline({ as_agent: 'alfa', lead_name: '!!!' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });
});

describe('append_lead_interaction', () => {
  it('appends a block to Histórico de interações in chronological order', async () => {
    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Carlos Lead',
      resumo: 'lead para teste de append'
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/carlos-lead.md');
    createdFiles.push(full);

    const r1 = await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Carlos Lead',
      channel: 'whatsapp', summary: 'primeiro contato',
      origem: 'campanha', timestamp: '2026-04-10T09:30:00Z',
    }, ctx);
    expect(r1.isError).toBeUndefined();
    expect((r1.structuredContent as any).bytes_appended).toBeGreaterThan(0);

    const r2 = await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Carlos Lead',
      channel: 'telefone', summary: 'visita agendada',
      next_step: 'enviar endereço', tags: ['#lead-quente'],
      timestamp: '2026-04-11T14:15:00Z',
    }, ctx);
    expect(r2.isError).toBeUndefined();

    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/## 2026-04-10 09:30/);
    expect(content).toMatch(/## 2026-04-11 14:15/);
    expect(content).toMatch(/Canal: whatsapp/);
    expect(content).toMatch(/Canal: telefone/);
    expect(content).toMatch(/Tags: #lead-quente/);
    const idx1 = content.indexOf('2026-04-10 09:30');
    const idx2 = content.indexOf('2026-04-11 14:15');
    expect(idx1).toBeLessThan(idx2);
  });

  it('LEAD_NOT_FOUND when lead doc does not exist', async () => {
    const r = await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Nonexistent',
      channel: 'x', summary: 'y',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEAD_NOT_FOUND');
  });

  it('uses now() when timestamp omitted, formatted as YYYY-MM-DD HH:MM', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Timestamp Test', resumo: 'x' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/timestamp-test.md');
    createdFiles.push(full);
    await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Timestamp Test',
      channel: 'email', summary: 'no ts passed',
    }, ctx);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });
});

describe('read_lead_history', () => {
  it('returns lead header + interactions parsed structurally', async () => {
    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Ana Read',
      resumo: 'r', interesse_atual: 'i', proximo_passo: 'p',
      objecoes_ativas: ['a', 'b'],
      status_comercial: 'negociando',
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/ana-read.md');
    createdFiles.push(full);

    await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Ana Read',
      channel: 'whatsapp', summary: 'primeiro',
      timestamp: '2026-04-10T09:30:00Z',
    }, ctx);
    await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Ana Read',
      channel: 'telefone', summary: 'segundo',
      objection: 'entrada', next_step: 'enviar sim',
      timestamp: '2026-04-11T14:15:00Z',
    }, ctx);

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

  it('order=asc returns chronological order', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Bruno Asc', resumo: 'x' }, ctx);
    createdFiles.push(path.join(FIXTURE, '_agents/alfa/lead/bruno-asc.md'));
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Bruno Asc', channel: 'x', summary: 'a', timestamp: '2026-04-10T09:00:00Z' }, ctx);
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Bruno Asc', channel: 'x', summary: 'b', timestamp: '2026-04-11T09:00:00Z' }, ctx);
    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Bruno Asc', order: 'asc' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions[0].timestamp).toBe('2026-04-10 09:00');
    expect(sc.interactions[1].timestamp).toBe('2026-04-11 09:00');
  });

  it('since filters out older interactions', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Dani Since', resumo: 'x' }, ctx);
    createdFiles.push(path.join(FIXTURE, '_agents/alfa/lead/dani-since.md'));
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Dani Since', channel: 'x', summary: 'old', timestamp: '2026-04-01T00:00:00Z' }, ctx);
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Dani Since', channel: 'x', summary: 'recent', timestamp: '2026-04-15T00:00:00Z' }, ctx);
    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Dani Since', since: '2026-04-10T00:00:00Z' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.interactions[0].summary).toBe('recent');
  });

  it('MALFORMED_LEAD_BODY warning yields interactions minus the bad block', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Edu Bad', resumo: 'x' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/edu-bad.md');
    createdFiles.push(full);
    const cur = fs.readFileSync(full, 'utf8');
    const corrupted = cur.replace(
      '## Histórico de interações\n',
      `## Histórico de interações\n\n## 2026-04-10 09:30\nCanal: ok\nResumo: good\n\n## not a timestamp\ngarbage\n`
    );
    fs.writeFileSync(full, corrupted);
    await ctx.index.updateAfterWrite('_agents/alfa/lead/edu-bad.md');

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
