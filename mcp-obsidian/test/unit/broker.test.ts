import { describe, it, expect } from 'vitest';
import { parseBrokerBody, serializeBrokerBody, serializeInteractionBlock } from '../../src/vault/broker.js';
import type { BrokerBody, BrokerInteraction } from '../../src/vault/broker.js';

describe('parseBrokerBody', () => {
  it('parses 4 header sections + interactions', () => {
    const body = `## Resumo
Broker experiente, 3 anos de Fama.

## Comunicação
Prefere WhatsApp. Responde rápido de manhã.

## Padrões de atendimento
Sempre abre com pergunta aberta. Fecha com CTA objetivo.

## Pendências abertas
- retornar sobre Union Vista
- enviar simulação pro lead João

## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Lead em contexto: joao-silva
Resumo: apoio na objeção de entrada

## 2026-04-11 14:15
Canal: telefone
Resumo: 1:1 semanal
Dificuldade: está perdendo leads frios
Encaminhamento: testar retomada de 14 dias
`;
    const r = parseBrokerBody(body);
    expect(r.headers.resumo).toContain('experiente');
    expect(r.headers.comunicacao).toContain('WhatsApp');
    expect(r.headers.padroes_atendimento).toContain('pergunta aberta');
    expect(r.headers.pendencias_abertas).toEqual(['retornar sobre Union Vista', 'enviar simulação pro lead João']);
    expect(r.interactions.length).toBe(2);
    expect(r.interactions[0].timestamp).toBe('2026-04-10 09:30');
    expect(r.interactions[0].channel).toBe('whatsapp');
    expect(r.interactions[0].contexto_lead).toBe('joao-silva');
    expect(r.interactions[1].dificuldade).toContain('perdendo leads');
    expect(r.interactions[1].encaminhamento).toContain('retomada de 14 dias');
    expect(r.malformed_blocks.length).toBe(0);
  });

  it('handles missing sections gracefully (null)', () => {
    const body = `## Resumo
only resumo.

## Histórico de interações`;
    const r = parseBrokerBody(body);
    expect(r.headers.resumo).toContain('only');
    expect(r.headers.comunicacao).toBeNull();
    expect(r.headers.padroes_atendimento).toBeNull();
    expect(r.headers.pendencias_abertas).toBeNull();
    expect(r.interactions).toEqual([]);
  });

  it('flags malformed blocks in interactions', () => {
    const body = `## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Resumo: ok

## bad header
garbage

## 2026-04-11 10:00
Canal: email
Resumo: valid`;
    const r = parseBrokerBody(body);
    expect(r.interactions.length).toBe(2);
    expect(r.malformed_blocks.length).toBe(1);
  });
});

describe('serializeBrokerBody round-trip', () => {
  it('round-trips full body', () => {
    const input: BrokerBody = {
      headers: {
        resumo: 'r', comunicacao: 'c', padroes_atendimento: 'p',
        pendencias_abertas: ['a', 'b'],
      },
      interactions: [
        { timestamp: '2026-04-10 09:30', channel: 'whatsapp', contexto_lead: 'joao', summary: 's', dificuldade: null, encaminhamento: null, tags: [] },
        { timestamp: '2026-04-11 14:15', channel: 'telefone', contexto_lead: null, summary: 's2', dificuldade: 'd', encaminhamento: 'e', tags: ['#broker-ativo'] },
      ],
      malformed_blocks: [],
    };
    const out = serializeBrokerBody(input);
    const reparsed = parseBrokerBody(out);
    expect(reparsed.headers.pendencias_abertas).toEqual(['a', 'b']);
    expect(reparsed.interactions.length).toBe(2);
    expect(reparsed.interactions[0].contexto_lead).toBe('joao');
    expect(reparsed.interactions[1].tags).toEqual(['#broker-ativo']);
  });
});
