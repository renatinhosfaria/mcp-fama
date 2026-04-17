// test/unit/financial.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseFinancialBody,
  serializeFinancialBody,
  extractFirstLine,
} from '../../src/vault/financial.js';

describe('parseFinancialBody', () => {
  it('extracts all 5 sections from canonical body', () => {
    const body = `## Caixa
Fluxo confortável, fechamento do mês confirmado.

## Receita
78% da meta. Driver: Union Vista.

## Despesa
Dentro do orçado; CAC -3% vs orçamento.

## Alertas
- Fluxo crítico em maio se 2 fechamentos não saírem
- CAC estourou 12%

## Contexto adicional
Mês com evento não-recorrente de comissão.
`;
    const r = parseFinancialBody(body);
    expect(r.caixa).toContain('confortável');
    expect(r.receita).toContain('78%');
    expect(r.despesa).toContain('orçado');
    expect(r.alertas).toEqual([
      'Fluxo crítico em maio se 2 fechamentos não saírem',
      'CAC estourou 12%',
    ]);
    expect(r.contexto).toContain('evento');
  });

  it('returns null for absent sections (graceful degradation)', () => {
    const body = `## Caixa
Apertado.
`;
    const r = parseFinancialBody(body);
    expect(r.caixa).toBe('Apertado.');
    expect(r.receita).toBeNull();
    expect(r.despesa).toBeNull();
    expect(r.alertas).toBeNull();
    expect(r.contexto).toBeNull();
  });

  it('returns [] for Alertas section present but no items', () => {
    const body = `## Alertas

## Contexto adicional
Tranquilo.
`;
    const r = parseFinancialBody(body);
    expect(r.alertas).toEqual([]);
    expect(r.contexto).toBe('Tranquilo.');
  });

  it('returns all-null for empty body', () => {
    const r = parseFinancialBody('');
    expect(r.caixa).toBeNull();
    expect(r.receita).toBeNull();
    expect(r.despesa).toBeNull();
    expect(r.alertas).toBeNull();
    expect(r.contexto).toBeNull();
  });
});

describe('extractFirstLine', () => {
  it('returns first non-empty trimmed line', () => {
    expect(extractFirstLine('\n\n  fluxo confortável  \nsecond line')).toBe('fluxo confortável');
  });
  it('returns null for all-whitespace input', () => {
    expect(extractFirstLine('\n   \n\t\n')).toBeNull();
  });
  it('returns null for null input', () => {
    expect(extractFirstLine(null)).toBeNull();
  });
});

describe('serializeFinancialBody', () => {
  it('emits 5 sections in canonical order', () => {
    const body = serializeFinancialBody({
      caixa: 'Apertado.',
      receita: '78% da meta.',
      despesa: 'OK.',
      alertas: ['Alerta 1', 'Alerta 2'],
      contexto: 'Tranquilo.',
    });
    // Section order matters
    const idxCaixa = body.indexOf('## Caixa');
    const idxReceita = body.indexOf('## Receita');
    const idxDespesa = body.indexOf('## Despesa');
    const idxAlertas = body.indexOf('## Alertas');
    const idxContexto = body.indexOf('## Contexto adicional');
    expect(idxCaixa).toBeGreaterThanOrEqual(0);
    expect(idxReceita).toBeGreaterThan(idxCaixa);
    expect(idxDespesa).toBeGreaterThan(idxReceita);
    expect(idxAlertas).toBeGreaterThan(idxDespesa);
    expect(idxContexto).toBeGreaterThan(idxAlertas);
    expect(body).toContain('- Alerta 1');
    expect(body).toContain('- Alerta 2');
  });

  it('omits null sections cleanly', () => {
    const body = serializeFinancialBody({
      caixa: 'Apertado.',
      receita: null,
      despesa: null,
      alertas: null,
      contexto: null,
    });
    expect(body).toContain('## Caixa');
    expect(body).not.toContain('## Receita');
    expect(body).not.toContain('## Alertas');
    expect(body).not.toContain('## Contexto adicional');
  });

  it('emits empty Alertas section when alertas is []', () => {
    const body = serializeFinancialBody({
      caixa: null, receita: null, despesa: null,
      alertas: [],
      contexto: null,
    });
    expect(body).toContain('## Alertas');
    expect(body).not.toContain('- ');
  });

  it('round-trip: serialize → parse returns same sections', () => {
    const sections = {
      caixa: 'Apertado mas ok.',
      receita: '78% da meta.',
      despesa: 'Dentro.',
      alertas: ['A', 'B'],
      contexto: 'Notas livres.',
    };
    const body = serializeFinancialBody(sections);
    const parsed = parseFinancialBody(body);
    expect(parsed.caixa).toBe(sections.caixa);
    expect(parsed.receita).toBe(sections.receita);
    expect(parsed.despesa).toBe(sections.despesa);
    expect(parsed.alertas).toEqual(sections.alertas);
    expect(parsed.contexto).toBe(sections.contexto);
  });
});
