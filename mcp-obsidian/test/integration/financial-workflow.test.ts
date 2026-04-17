// test/integration/financial-workflow.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import {
  upsertFinancialSnapshot,
  readFinancialSeries,
} from '../../src/tools/workflows.js';

describe('financial-snapshot workflow', () => {
  let tmp: string;
  let ctx: any;

  const setupVault = async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fin-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      [
        '```',
        '_shared/financials/*/cfo-exec.md => cfo-exec',
        '_shared/financials/*/ceo-exec.md => ceo-exec',
        '```',
      ].join('\n'),
    );
    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  };

  beforeAll(setupVault);
  beforeEach(setupVault);

  it('creates snapshot with all 5 sections + auto-extracts *_resumo + auto-counts alertas', async () => {
    const r = await upsertFinancialSnapshot(
      {
        as_agent: 'cfo-exec',
        period: '2026-04',
        caixa: 'Fluxo confortável, fechamento confirmado.',
        receita: '78% da meta. Driver: Union Vista.',
        despesa: 'Dentro do orçado; CAC -3%.',
        alertas: ['Fluxo crítico maio', 'CAC estourou 12%'],
        contexto: 'Evento não-recorrente de comissão.',
      },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.path).toBe('_shared/financials/2026-04/cfo-exec.md');
    expect(sc.created_or_updated).toBe('created');

    // Verify frontmatter injection
    const raw = fs.readFileSync(path.join(tmp, sc.path), 'utf8');
    expect(raw).toContain("type: financial-snapshot");
    expect(raw).toMatch(/period: '?2026-04'?/);
    expect(raw).toContain('alertas_count: 2');
    expect(raw).toMatch(/caixa_resumo: '?Fluxo confortável/);
    expect(raw).toMatch(/receita_resumo: '?78% da meta\./);
    expect(raw).toMatch(/despesa_resumo: '?Dentro do orçado;?/);
  });

  it('rejects bad period with INVALID_PERIOD', async () => {
    const r = await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-13', caixa: 'x' },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_PERIOD');
  });

  it('rejects *_resumo with newline via INVALID_FRONTMATTER', async () => {
    const r = await upsertFinancialSnapshot(
      {
        as_agent: 'cfo-exec',
        period: '2026-04',
        caixa: 'x',
        caixa_resumo: 'line1\nline2',
      },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_FRONTMATTER');
  });

  it('update merges: fields not passed keep prior values', async () => {
    // First: create with caixa + receita
    await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', caixa: 'v1 caixa.', receita: 'v1 receita.' },
      ctx,
    );
    // Update with only despesa → caixa/receita must persist
    const r = await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', despesa: 'v1 despesa.' },
      ctx,
    );
    expect((r as any).structuredContent.created_or_updated).toBe('updated');
    const read = await readFinancialSeries(
      { as_agent: 'cfo-exec', periods: ['2026-04'] },
      ctx,
    );
    const snap = (read as any).structuredContent.snapshots[0];
    expect(snap.caixa).toBe('v1 caixa.');
    expect(snap.receita).toBe('v1 receita.');
    expect(snap.despesa).toBe('v1 despesa.');
  });

  it('clears a section when empty string is passed', async () => {
    await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', caixa: 'v1.', receita: 'v1.' },
      ctx,
    );
    await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', caixa: '' },
      ctx,
    );
    const read = await readFinancialSeries(
      { as_agent: 'cfo-exec', periods: ['2026-04'] },
      ctx,
    );
    const snap = (read as any).structuredContent.snapshots[0];
    expect(snap.caixa).toBeNull();
    expect(snap.receita).toBe('v1.');
  });

  it('read with since/until lexicographic range returns desc order', async () => {
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-02', caixa: 'fev' }, ctx);
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-03', caixa: 'mar' }, ctx);
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-04', caixa: 'abr' }, ctx);
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-05', caixa: 'mai' }, ctx);

    const r = await readFinancialSeries(
      { as_agent: 'cfo-exec', since: '2026-03', until: '2026-04' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.snapshots).toHaveLength(2);
    expect(sc.snapshots[0].period).toBe('2026-04');
    expect(sc.snapshots[1].period).toBe('2026-03');
  });

  it('read with explicit periods[] missing entry throws SNAPSHOT_NOT_FOUND', async () => {
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-04', caixa: 'abr' }, ctx);
    const r = await readFinancialSeries(
      { as_agent: 'cfo-exec', periods: ['2026-04', '2026-03'] },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('SNAPSHOT_NOT_FOUND');
  });

  it('read with since/until silently omits missing periods', async () => {
    // Only 2026-04 exists in this range
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-04', caixa: 'abr' }, ctx);
    const r = await readFinancialSeries(
      { as_agent: 'cfo-exec', since: '2026-01', until: '2026-06' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.snapshots).toHaveLength(1);
    expect(sc.snapshots[0].period).toBe('2026-04');
  });
});
