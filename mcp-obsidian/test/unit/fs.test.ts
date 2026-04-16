// test/unit/fs.test.ts
import { describe, it, expect } from 'vitest';
import { asciiFold, toKebabSlug, validateFilename, validateJournalFilename } from '../../src/vault/fs.js';

describe('asciiFold', () => {
  it('removes diacritics', () => {
    expect(asciiFold('decisão')).toBe('decisao');
    expect(asciiFold('São João')).toBe('Sao Joao');
    expect(asciiFold('ç')).toBe('c');
  });
  it('is idempotent', () => {
    const folded = asciiFold('ação');
    expect(asciiFold(folded)).toBe(folded);
  });
});

describe('toKebabSlug', () => {
  it('lowercases and kebabs', () => {
    expect(toKebabSlug('João Silva')).toBe('joao-silva');
    expect(toKebabSlug('Ações de Cobrança')).toBe('acoes-de-cobranca');
    expect(toKebabSlug('  multiple   spaces  ')).toBe('multiple-spaces');
  });
  it('drops non-alphanum besides hyphen', () => {
    expect(toKebabSlug('a/b\\c?d')).toBe('a-b-c-d');
  });
  it('is idempotent', () => {
    expect(toKebabSlug(toKebabSlug('Ação Y!'))).toBe('acao-y');
  });
});

describe('validateFilename', () => {
  it('accepts kebab .md', () => {
    expect(() => validateFilename('foo-bar.md')).not.toThrow();
  });
  it('rejects uppercase, spaces, leading hyphen, missing .md', () => {
    expect(() => validateFilename('Foo.md')).toThrow(/INVALID_FILENAME/);
    expect(() => validateFilename('foo bar.md')).toThrow();
    expect(() => validateFilename('-foo.md')).toThrow();
    expect(() => validateFilename('foo.txt')).toThrow();
  });
});

describe('validateJournalFilename', () => {
  it('accepts YYYY-MM-DD-slug.md', () => {
    expect(() => validateJournalFilename('2026-04-16-titulo-curto.md')).not.toThrow();
  });
  it('rejects others', () => {
    expect(() => validateJournalFilename('foo.md')).toThrow();
    expect(() => validateJournalFilename('2026-4-16-x.md')).toThrow();
  });
});
