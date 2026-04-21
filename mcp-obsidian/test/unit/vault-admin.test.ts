import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';
import { ownerCheck, isVaultAdmin, VAULT_ADMIN_ROLE, isJournalPath, isDecisionsPath } from '../../src/tools/_shared.js';

const FIXTURE = path.resolve('test/fixtures/vault');

describe('vault_admin role', () => {
  it('VAULT_ADMIN_ROLE is "vault_admin"', () => {
    expect(VAULT_ADMIN_ROLE).toBe('vault_admin');
  });

  it('isVaultAdmin matches only the admin role', () => {
    expect(isVaultAdmin('vault_admin')).toBe(true);
    expect(isVaultAdmin('vault')).toBe(false);
    expect(isVaultAdmin('alfa')).toBe(false);
    expect(isVaultAdmin('')).toBe(false);
  });

  it('ownerCheck bypasses OWNERSHIP_VIOLATION for vault_admin', async () => {
    const index = new VaultIndex(FIXTURE);
    await index.build();
    const ctx = { index, vaultRoot: FIXTURE };
    await expect(ownerCheck(ctx, '_agents/alfa/profile.md', 'vault_admin')).resolves.toBeUndefined();
  });

  it('ownerCheck bypasses UNMAPPED_PATH for vault_admin', async () => {
    const index = new VaultIndex(FIXTURE);
    await index.build();
    const ctx = { index, vaultRoot: FIXTURE };
    await expect(ownerCheck(ctx, '_totally_unmapped/thing.md', 'vault_admin')).resolves.toBeUndefined();
  });

  it('ownerCheck still rejects non-admin role trying to write elsewhere', async () => {
    const index = new VaultIndex(FIXTURE);
    await index.build();
    const ctx = { index, vaultRoot: FIXTURE };
    await expect(ownerCheck(ctx, '_agents/alfa/profile.md', 'beta')).rejects.toMatchObject({
      code: 'OWNERSHIP_VIOLATION',
    });
  });

  it('ownerCheck still rejects non-admin role on unmapped path', async () => {
    const index = new VaultIndex(FIXTURE);
    await index.build();
    const ctx = { index, vaultRoot: FIXTURE };
    await expect(ownerCheck(ctx, '_nowhere/x.md', 'alfa')).rejects.toMatchObject({
      code: 'UNMAPPED_PATH',
    });
  });
});

describe('immutability helpers', () => {
  it('isDecisionsPath matches decisions.md at any depth', () => {
    expect(isDecisionsPath('_agents/alfa/decisions.md')).toBe(true);
    expect(isDecisionsPath('decisions.md')).toBe(true);
    expect(isDecisionsPath('_agents/alfa/journal/2026-04-15-x.md')).toBe(false);
    expect(isDecisionsPath('_agents/alfa/profile.md')).toBe(false);
  });

  it('isJournalPath matches _agents/<role>/journal/*.md only', () => {
    expect(isJournalPath('_agents/alfa/journal/2026-04-15-x.md')).toBe(true);
    expect(isJournalPath('_agents/vault/journal/2026-04-21-note.md')).toBe(true);
    expect(isJournalPath('_agents/alfa/profile.md')).toBe(false);
    expect(isJournalPath('_agents/alfa/decisions.md')).toBe(false);
    expect(isJournalPath('_shared/journal/x.md')).toBe(false);
    expect(isJournalPath('journal/x.md')).toBe(false);
  });
});
