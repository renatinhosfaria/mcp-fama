import { describe, it, expect } from 'vitest';
import { parseFrontmatter, serializeFrontmatter, FRONTMATTER_TYPES } from '../../src/vault/frontmatter.js';

describe('FRONTMATTER_TYPES', () => {
  it('has 14 valid type values (financial-snapshot is plan 6)', () => {
    expect(FRONTMATTER_TYPES).toEqual([
      'moc','context','agents-map','goal','goals-index',
      'result','results-index','agent-readme','agent-profile',
      'agent-decisions','journal','project-readme',
      'shared-context','entity-profile',
    ]);
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
});
