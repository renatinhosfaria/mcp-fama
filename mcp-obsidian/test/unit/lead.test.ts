// test/unit/lead.test.ts
import { describe, it, expect } from 'vitest';
import { parseLeadBody, serializeLeadBody, parseInteractionBlocks, serializeInteractionBlock } from '../../src/vault/lead.js';
import type { LeadBody, LeadInteraction } from '../../src/vault/lead.js';

describe('parseLeadBody', () => {
  it('parses 4 header sections + interactions', () => {
    const body = `## Resumo
Lead interessado em 2Q.

## Interesse atual
Imóvel pronto.

## Objeções ativas
- entrada alta
- medo da parcela

## Próximo passo
Ligar na terça.

## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Origem: campanha-union-vista
Resumo: primeiro contato, entrou por tráfego pago

## 2026-04-11 14:15
Canal: telefone
Resumo: apresentou unidades disponíveis
Objeção: acha entrada alta
Próximo passo: enviar simulação CEF
`;
    const r = parseLeadBody(body);
    expect(r.headers.resumo).toContain('interessado em 2Q');
    expect(r.headers.interesse_atual).toContain('Imóvel pronto');
    expect(r.headers.objecoes_ativas).toEqual(['entrada alta', 'medo da parcela']);
    expect(r.headers.proximo_passo).toContain('terça');
    expect(r.interactions.length).toBe(2);
    expect(r.interactions[0].timestamp).toBe('2026-04-10 09:30');
    expect(r.interactions[0].channel).toBe('whatsapp');
    expect(r.interactions[0].origem).toBe('campanha-union-vista');
    expect(r.interactions[1].objection).toContain('entrada alta');
    expect(r.interactions[1].next_step).toContain('simulação');
    expect(r.malformed_blocks.length).toBe(0);
  });

  it('returns null for missing header sections (partial lead)', () => {
    const body = `## Resumo
Only resumo exists.

## Histórico de interações`;
    const r = parseLeadBody(body);
    expect(r.headers.resumo).toContain('Only');
    expect(r.headers.interesse_atual).toBeNull();
    expect(r.headers.objecoes_ativas).toBeNull();
    expect(r.headers.proximo_passo).toBeNull();
    expect(r.interactions).toEqual([]);
  });

  it('handles missing delimiter (no história section) — interactions empty', () => {
    const body = `## Resumo
x

## Interesse atual
y`;
    const r = parseLeadBody(body);
    expect(r.interactions).toEqual([]);
    expect(r.headers.resumo).toContain('x');
  });

  it('flags malformed blocks as warnings, returns valid ones', () => {
    const body = `## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Resumo: ok

## this is not a timestamp
garbage line

## 2026-04-11 10:00
Canal: email
Resumo: valid again`;
    const r = parseLeadBody(body);
    expect(r.interactions.length).toBe(2);
    expect(r.malformed_blocks.length).toBe(1);
    expect(r.malformed_blocks[0].line).toBeGreaterThan(0);
    expect(r.malformed_blocks[0].reason).toMatch(/timestamp/i);
  });
});

describe('serializeLeadBody round-trip', () => {
  it('round-trips a full lead body', () => {
    const input: LeadBody = {
      headers: {
        resumo: 'r',
        interesse_atual: 'i',
        objecoes_ativas: ['a', 'b'],
        proximo_passo: 'p',
      },
      interactions: [
        { timestamp: '2026-04-10 09:30', channel: 'whatsapp', origem: 'x', summary: 'hi', objection: null, next_step: null, tags: [] },
        { timestamp: '2026-04-11 14:15', channel: 'telefone', origem: null, summary: 's', objection: 'o', next_step: 'n', tags: ['#lead-quente'] },
      ],
      malformed_blocks: [],
    };
    const serialized = serializeLeadBody(input);
    const reparsed = parseLeadBody(serialized);
    expect(reparsed.headers.resumo).toBe('r');
    expect(reparsed.headers.objecoes_ativas).toEqual(['a', 'b']);
    expect(reparsed.interactions.length).toBe(2);
    expect(reparsed.interactions[0].channel).toBe('whatsapp');
    expect(reparsed.interactions[1].tags).toEqual(['#lead-quente']);
  });
});
