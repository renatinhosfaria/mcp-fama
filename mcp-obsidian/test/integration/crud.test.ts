// test/integration/crud.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { readNote } from '../../src/tools/crud.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

describe('read_note', () => {
  it('returns frontmatter, content, and metadata', async () => {
    const r = await readNote({ path: '_agents/alfa/decisions.md' }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).frontmatter.type).toBe('agent-decisions');
    expect((r.structuredContent as any).path).toBe('_agents/alfa/decisions.md');
    expect((r.structuredContent as any).content).toContain('first decision');
    expect((r.structuredContent as any).bytes).toBeGreaterThan(0);
  });
  it('throws NOTE_NOT_FOUND for missing file', async () => {
    const r = await readNote({ path: '_agents/missing.md' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('NOTE_NOT_FOUND');
  });
  it('throws VAULT_IO_ERROR on path traversal', async () => {
    const r = await readNote({ path: '../etc/passwd' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('VAULT_IO_ERROR');
  });
});
