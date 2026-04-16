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

import { safeJoin, readFileAtomic, writeFileAtomic, appendFileAtomic, deleteFile, statFile } from '../../src/vault/fs.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { beforeEach, afterEach } from 'vitest';

describe('safeJoin', () => {
  it('joins relative path under vault root', () => {
    expect(safeJoin('/v', '_agents/ceo/README.md')).toBe('/v/_agents/ceo/README.md');
  });
  it('rejects ..', () => {
    expect(() => safeJoin('/v', '../etc/passwd')).toThrow(/VAULT_IO_ERROR/);
    expect(() => safeJoin('/v', '_agents/../../etc')).toThrow();
  });
  it('rejects absolute paths', () => {
    expect(() => safeJoin('/v', '/etc/passwd')).toThrow();
  });
  it('rejects empty', () => {
    expect(() => safeJoin('/v', '')).toThrow();
  });
});

describe('atomic file ops', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fs-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writeFileAtomic creates parent dirs and writes', async () => {
    await writeFileAtomic(path.join(tmp, 'a/b/c.md'), 'hello');
    expect(fs.readFileSync(path.join(tmp, 'a/b/c.md'), 'utf8')).toBe('hello');
  });
  it('readFileAtomic returns content + mtime', async () => {
    fs.writeFileSync(path.join(tmp, 'r.md'), 'data');
    const r = await readFileAtomic(path.join(tmp, 'r.md'));
    expect(r.content).toBe('data');
    expect(r.mtimeMs).toBeGreaterThan(0);
  });
  it('appendFileAtomic appends', async () => {
    fs.writeFileSync(path.join(tmp, 'a.md'), 'one\n');
    const r = await appendFileAtomic(path.join(tmp, 'a.md'), 'two');
    expect(r.bytesAppended).toBe(3);
    expect(fs.readFileSync(path.join(tmp, 'a.md'), 'utf8')).toBe('one\ntwo');
  });
  it('deleteFile removes', async () => {
    fs.writeFileSync(path.join(tmp, 'd.md'), 'x');
    await deleteFile(path.join(tmp, 'd.md'));
    expect(fs.existsSync(path.join(tmp, 'd.md'))).toBe(false);
  });
  it('readFileAtomic throws NOTE_NOT_FOUND', async () => {
    await expect(readFileAtomic(path.join(tmp, 'missing.md'))).rejects.toThrow(/NOTE_NOT_FOUND/);
  });
  it('statFile returns null for missing', async () => {
    expect(await statFile(path.join(tmp, 'missing.md'))).toBeNull();
  });
});
