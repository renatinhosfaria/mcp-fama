import { describe, it, expect } from 'vitest';
import { parseFrontmatter, serializeFrontmatter, FRONTMATTER_TYPES } from '../../src/vault/frontmatter.js';

describe('FRONTMATTER_TYPES', () => {
  it('has 23 valid type values including v1 types', () => {
    expect(FRONTMATTER_TYPES).toEqual([
      'moc','context','agents-map','goal','goals-index',
      'result','results-index','agent-readme','agent-profile',
      'agent-decisions','journal','project-readme',
      'shared-context','entity-profile','financial-snapshot',
      'entity','decision','concept','reference','runbook',
      'hub','interaction','project',
    ]);
  });
});

describe('legacy frontmatter type extensions', () => {
  const base = `owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: [fam]`;

  const cases = [
    {
      type: 'entity',
      fields: `subtype: person
aliases: [Joao]
relationships:
  - kind: works-with
external_ids:
  crm: "123"`,
      omitRequired: 'subtype',
    },
    {
      type: 'decision',
      fields: `decided_by: alfa
supersedes: old-decision`,
      omitRequired: 'decided_by',
    },
    {
      type: 'concept',
      fields: `derives_from: source-concept`,
      omitRequired: 'owner',
    },
    {
      type: 'reference',
      fields: `source_url: https://example.com/ref
source_author: Example Author
source_date: 2026-04-01`,
      omitRequired: 'source_url',
    },
    {
      type: 'runbook',
      fields: `procedure_owner: ops
trigger: incident-opened`,
      omitRequired: 'procedure_owner',
    },
    {
      type: 'hub',
      fields: `scope: sales
maintainer: alfa`,
      omitRequired: 'scope',
    },
    {
      type: 'interaction',
      fields: `channel: whatsapp
participants: [alfa, cliente]`,
      omitRequired: 'participants',
    },
    {
      type: 'project',
      fields: `goal: deliver migration
status_lifecycle: active`,
      omitRequired: 'goal',
    },
  ];

  for (const c of cases) {
    it(`accepts valid ${c.type} frontmatter`, () => {
      const src = `---
type: ${c.type}
${base}
${c.fields}
---
body`;
      const r = parseFrontmatter(src);
      expect(r.frontmatter!.type).toBe(c.type);
    });

    it(`rejects ${c.type} frontmatter missing required ${c.omitRequired}`, () => {
      const src = `---
type: ${c.type}
${c.omitRequired === 'owner' ? base.replace('owner: alfa\n', '') : base}
${c.fields
  .split('\n')
  .filter(line => !line.startsWith(`${c.omitRequired}:`))
  .join('\n')}
---
body`;
      expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
    });
  }
});

describe('v1 frontmatter types', () => {
  const base = `schema_version: 1
status: active
created: 2026-04-01
updated: 2026-04-01
source: agent-generated
tags: [fam]`;

  const cases = [
    {
      type: 'entity',
      fields: `subtype: person
aliases: [Joao]
relationships:
  - kind: works-with
external_ids:
  crm: "123"`,
      omitRequired: 'subtype',
    },
    {
      type: 'decision',
      fields: `decided_by: alfa
supersedes: old-decision`,
      omitRequired: 'decided_by',
    },
    {
      type: 'concept',
      fields: `derives_from: source-concept`,
    },
    {
      type: 'reference',
      fields: `source_url: https://example.com/ref
source_author: Example Author
source_date: 2026-04-01`,
      omitRequired: 'source_url',
    },
    {
      type: 'runbook',
      fields: `procedure_owner: ops
trigger: incident-opened`,
      omitRequired: 'procedure_owner',
    },
    {
      type: 'hub',
      fields: `scope: sales
maintainer: alfa`,
      omitRequired: 'scope',
    },
    {
      type: 'interaction',
      fields: `channel: whatsapp
participants: [alfa, cliente]`,
      omitRequired: 'participants',
    },
    {
      type: 'project',
      fields: `goal: deliver migration
status_lifecycle: active`,
      omitRequired: 'goal',
    },
  ];

  for (const c of cases) {
    it(`accepts valid ${c.type} v1 frontmatter without legacy owner`, () => {
      const src = `---
type: ${c.type}
${base}
${c.fields}
---
body`;
      const r = parseFrontmatter(src);
      expect(r.frontmatter!.type).toBe(c.type);
      expect(r.frontmatter!.schema_version).toBe(1);
      expect(r.frontmatter!.owner).toBeUndefined();
    });

    if (c.omitRequired) {
      it(`rejects ${c.type} v1 frontmatter missing required ${c.omitRequired}`, () => {
        const src = `---
type: ${c.type}
${base}
${c.fields
  .split('\n')
  .filter(line => !line.startsWith(`${c.omitRequired}:`))
  .join('\n')}
---
body`;
        expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
      });
    }
  }

  it('accepts decision v1 link fields as arrays', () => {
    const r = parseFrontmatter(`---
schema_version: 1
type: decision
status: active
created: 2026-04-01
updated: 2026-04-01
source: agent-generated
tags: [fam]
decided_by: []
supersedes: []
superseded_by:
  - '[[decisions/next]]'
mentions_entity:
  - '[[Bruno]]'
implements:
  - '[[projects/reno-first]]'
related: []
---
body`);
    expect(r.frontmatter?.decided_by).toEqual([]);
    expect(r.frontmatter?.supersedes).toEqual([]);
    expect(r.frontmatter?.superseded_by).toEqual(['[[decisions/next]]']);
    expect(r.frontmatter?.mentions_entity).toEqual(['[[Bruno]]']);
    expect(r.frontmatter?.implements).toEqual(['[[projects/reno-first]]']);
    expect(r.frontmatter?.related).toEqual([]);
  });
});

describe('schema v1 parsing', () => {
  it('accepts v1 ISO date fields and passthrough extras', () => {
    const r = parseFrontmatter(`---
schema_version: 1
type: interaction
status: active
created: 2026-05-11T14:30:00-03:00
updated: 2026-05-11
source: agent-generated
tags: [reno]
participants: ['[[Bruno]]']
channel: whatsapp
occurred_at: 2026-05-11T14:35:00-03:00
unknown_field: kept
---
body`);
    expect(r.frontmatter?.schema_version).toBe(1);
    expect(r.frontmatter?.created).toBe('2026-05-11T14:30:00-03:00');
    expect(r.frontmatter?.occurred_at).toBe('2026-05-11T14:35:00-03:00');
    expect(r.frontmatter?.unknown_field).toBe('kept');
  });
});

describe('parseFrontmatter — base', () => {
  it('parses minimal valid frontmatter', () => {
    const src = `---
type: moc
owner: ceo
created: 2026-04-01
updated: 2026-04-10
tags: [paperclip]
---
# body`;
    const r = parseFrontmatter(src);
    expect(r.frontmatter!.type).toBe('moc');
    expect(r.frontmatter!.owner).toBe('ceo');
    expect(r.body.trim()).toBe('# body');
  });

  it('preserves legacy ISO date fields without timezone shift', () => {
    const src = `---
type: journal
owner: ceo
created: 2026-05-11T23:30:00-03:00
updated: 2026-05-11T23:30:00-03:00
tags: []
---
# body`;
    const r = parseFrontmatter(src);
    expect(r.frontmatter!.created).toBe('2026-05-11T23:30:00-03:00');
    expect(r.frontmatter!.updated).toBe('2026-05-11T23:30:00-03:00');
  });

  it('rejects missing required fields', () => {
    const src = `---\ntype: moc\nowner: ceo\n---\nx`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('rejects unknown type', () => {
    const src = `---
type: garbage
owner: ceo
created: 2026-04-01
updated: 2026-04-10
tags: []
---`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('returns frontmatter:null for legacy file with no frontmatter (no throw)', () => {
    const r = parseFrontmatter('Just body, no frontmatter');
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe('Just body, no frontmatter');
  });
});

describe('round-trip', () => {
  it('preserves arbitrary extra fields via passthrough', () => {
    const src = `---
type: moc
owner: ceo
created: 2026-04-01
updated: 2026-04-10
tags: [a]
foo: bar
nested:
  x: 1
---
body content`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).foo).toBe('bar');
    const round = parseFrontmatter(serializeFrontmatter(r.frontmatter!, r.body));
    expect((round.frontmatter as any).foo).toBe('bar');
    expect((round.frontmatter as any).nested.x).toBe(1);
  });

  it('shared-context requires topic + title', () => {
    const bad = `---
type: shared-context
owner: reno
created: 2026-04-01
updated: 2026-04-01
tags: []
---`;
    expect(() => parseFrontmatter(bad)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('entity-profile requires entity_type + entity_name (kebab)', () => {
    const ok = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-01
tags: []
entity_type: lead
entity_name: João Silva
---`;
    expect(() => parseFrontmatter(ok)).not.toThrow();
    const bad = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-01
tags: []
entity_type: Has Spaces
entity_name: x
---`;
    expect(() => parseFrontmatter(bad)).toThrow();
  });

  describe('entity_type=lead sub-branch', () => {
    it('accepts lead-specific optional fields', () => {
      const src = `---
type: entity-profile
owner: reno
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: lead
entity_name: João Silva
status_comercial: qualificando
origem: campanha-union-vista
interesse_atual: 2-dormitorios
objecoes_ativas:
  - entrada alta
  - medo da parcela
proximo_passo: retomar com qualificação de renda
---
body`;
      const r = parseFrontmatter(src);
      expect((r.frontmatter as any).entity_type).toBe('lead');
      expect((r.frontmatter as any).status_comercial).toBe('qualificando');
      expect((r.frontmatter as any).objecoes_ativas).toEqual(['entrada alta', 'medo da parcela']);
      expect((r.frontmatter as any).proximo_passo).toContain('qualificação');
    });

    it('rejects objecoes_ativas when not an array of strings', () => {
      const src = `---
type: entity-profile
owner: reno
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: lead
entity_name: x
objecoes_ativas: "not an array"
---`;
      expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
    });
  });

  describe('entity_type=broker sub-branch', () => {
    it('accepts broker-specific optional fields', () => {
      const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: Maria Eduarda
equipe: centro
nivel_engajamento: ativo
comunicacao_estilo: direta e objetiva
contato_email: maria@fama.com
contato_whatsapp: "+5511999999999"
dificuldades_recorrentes:
  - objeção de entrada
  - medo de financiamento longo
padroes_atendimento: escuta ativa primeiro, depois apresentação
pendencias_abertas:
  - retornar sobre Union Vista
---
body`;
      const r = parseFrontmatter(src);
      expect((r.frontmatter as any).entity_type).toBe('broker');
      expect((r.frontmatter as any).equipe).toBe('centro');
      expect((r.frontmatter as any).dificuldades_recorrentes).toEqual(['objeção de entrada', 'medo de financiamento longo']);
      expect((r.frontmatter as any).pendencias_abertas).toHaveLength(1);
    });

    it('rejects dificuldades_recorrentes when not array of strings', () => {
      const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: x
dificuldades_recorrentes: not-an-array
---`;
      expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
    });
  });

  describe('broker sub-branch executive extension (Plan 7)', () => {
    it('accepts nivel_atencao and ultima_acao_recomendada', () => {
      const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: Maria Eduarda
nivel_atencao: risco
ultima_acao_recomendada: ligar para alinhar pendência sobre lead João Silva
---
body`;
      const r = parseFrontmatter(src);
      expect((r.frontmatter as any).nivel_atencao).toBe('risco');
      expect((r.frontmatter as any).ultima_acao_recomendada).toContain('ligar para alinhar');
    });

    it('rejects ultima_acao_recomendada containing newline', () => {
      const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: X
ultima_acao_recomendada: "line1\\nline2"
---
body`;
      expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
    });

    it('accepts nivel_atencao as free string (vocabulary not enforced per §5.6)', () => {
      const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: X
nivel_atencao: experimental-level
---
body`;
      const r = parseFrontmatter(src);
      expect((r.frontmatter as any).nivel_atencao).toBe('experimental-level');
    });
  });
});

describe('financial-snapshot frontmatter branch', () => {
  it('accepts valid financial-snapshot with all optional resumo fields', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
period: 2026-04
caixa_resumo: fluxo confortável
receita_resumo: 78% da meta
despesa_resumo: dentro do orçado
alertas_count: 2
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).type).toBe('financial-snapshot');
    expect((r.frontmatter as any).period).toBe('2026-04');
    expect((r.frontmatter as any).caixa_resumo).toBe('fluxo confortável');
    expect((r.frontmatter as any).alertas_count).toBe(2);
  });

  it('rejects financial-snapshot without period', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
---
body`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('rejects financial-snapshot with period not YYYY-MM', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
period: 2026/04
---
body`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('accepts financial-snapshot without any resumo field', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
period: 2026-04
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).type).toBe('financial-snapshot');
    expect((r.frontmatter as any).period).toBe('2026-04');
    expect((r.frontmatter as any).caixa_resumo).toBeUndefined();
  });
});
