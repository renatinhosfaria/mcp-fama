// test/unit/regressao.test.ts
import { describe, it, expect } from 'vitest';
import { parseRegressaoBody } from '../../src/vault/regressao.js';

describe('parseRegressaoBody', () => {
  it('extracts all 7 canonical fields', () => {
    const body = `## Agente alvo
reno

## Cenário
Lead objetou entrada alta; Reno respondeu em tom frio.

## Comportamento esperado
Reconhecer a objeção, oferecer alternativa (entrada menor / parcela maior).

## Comportamento observado
"Entendo, mas esse é o valor." — tom seco, sem alternativa.

## Severidade
alta

## Status
aberta

## Categoria
tom

## Histórico
- 2026-04-10 14:30 regressão detectada
- 2026-04-12 09:00 retestada, mesmo comportamento
`;
    const r = parseRegressaoBody(body);
    expect(r.agente_alvo).toBe('reno');
    expect(r.cenario).toContain('tom frio');
    expect(r.comportamento_esperado).toContain('alternativa');
    expect(r.comportamento_observado).toContain('seco');
    expect(r.severidade).toBe('alta');
    expect(r.status).toBe('aberta');
    expect(r.categoria).toBe('tom');
    expect(r.historico).toEqual([
      '2026-04-10 14:30 regressão detectada',
      '2026-04-12 09:00 retestada, mesmo comportamento',
    ]);
  });

  it('returns null for missing sections (graceful degradation)', () => {
    const body = `## Agente alvo
followup

## Severidade
media
`;
    const r = parseRegressaoBody(body);
    expect(r.agente_alvo).toBe('followup');
    expect(r.severidade).toBe('media');
    expect(r.cenario).toBeNull();
    expect(r.comportamento_esperado).toBeNull();
    expect(r.status).toBeNull();
    expect(r.categoria).toBeNull();
    expect(r.historico).toBeNull();
  });

  it('returns all-null for empty body', () => {
    const r = parseRegressaoBody('');
    expect(r.agente_alvo).toBeNull();
    expect(r.cenario).toBeNull();
    expect(r.comportamento_esperado).toBeNull();
    expect(r.comportamento_observado).toBeNull();
    expect(r.severidade).toBeNull();
    expect(r.status).toBeNull();
    expect(r.categoria).toBeNull();
    expect(r.historico).toBeNull();
  });

  it('trims whitespace from single-line sections', () => {
    const body = `## Agente alvo
   reno

## Severidade
    baixa
`;
    const r = parseRegressaoBody(body);
    expect(r.agente_alvo).toBe('reno');
    expect(r.severidade).toBe('baixa');
  });

  it('historico without dash-list entries returns null', () => {
    const body = `## Histórico
no list items, just prose that shouldn't be a list
`;
    const r = parseRegressaoBody(body);
    expect(r.historico).toBeNull();
  });
});
