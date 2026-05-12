import { describe, it, expect } from 'vitest';
import { normalizeTag, normalizeTags } from '../../src/vault/tags.js';

describe('normalizeTag', () => {
  it('passes already-clean kebab-case unchanged', () => {
    const r = normalizeTag('lead-quente');
    expect(r.tag).toBe('lead-quente');
    expect(r.warning).toBeNull();
  });

  it('preserves leading hash', () => {
    const r = normalizeTag('#lead-quente');
    expect(r.tag).toBe('#lead-quente');
    expect(r.warning).toBeNull();
  });

  it('converts underscores to hyphens', () => {
    const r = normalizeTag('lead_quente');
    expect(r.tag).toBe('lead-quente');
    expect(r.warning).toMatch(/normalized/);
  });

  it('strips trailing date suffix', () => {
    const r = normalizeTag('contato_2026-04-27');
    expect(r.tag).toBe('contato');
    expect(r.warning).toMatch(/normalized/);
  });

  it('strips trailing ISO timestamp', () => {
    const r = normalizeTag('contato-2026-04-27T12:34:56Z');
    expect(r.tag).toBe('contato');
  });

  it('preserves nested-tag separator (/)', () => {
    const r = normalizeTag('regiao/jardim_karaiba');
    expect(r.tag).toBe('regiao/jardim-karaiba');
  });

  it('ASCII-folds + lowercases', () => {
    const r = normalizeTag('Região-Sul');
    expect(r.tag).toBe('regiao-sul');
    expect(r.warning).toMatch(/normalized/);
  });

  it('collapses repeated hyphens and trims edges', () => {
    const r = normalizeTag('--lead--quente--');
    expect(r.tag).toBe('lead-quente');
  });

  it('replaces non-allowed runs with single hyphen', () => {
    const r = normalizeTag('lead!@#quente');
    expect(r.tag).toBe('lead-quente');
  });
});

describe('normalizeTags', () => {
  it('returns empty result for empty input', () => {
    expect(normalizeTags([])).toEqual({ tags: [], warnings: [] });
    expect(normalizeTags(undefined)).toEqual({ tags: [], warnings: [] });
  });

  it('deduplicates after normalization', () => {
    const r = normalizeTags(['lead_quente', 'lead-quente', 'lead-Quente']);
    expect(r.tags).toEqual(['lead-quente']);
    expect(r.warnings.length).toBe(2);
  });

  it('drops empties produced by normalization', () => {
    const r = normalizeTags(['---', '#', 'real-tag']);
    expect(r.tags).toEqual(['real-tag']);
  });

  it('preserves first-seen order', () => {
    const r = normalizeTags(['c', 'a', 'b']);
    expect(r.tags).toEqual(['c', 'a', 'b']);
  });
});
