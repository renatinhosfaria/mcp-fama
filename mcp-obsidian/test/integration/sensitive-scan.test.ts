import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';
import { scanSensitiveData } from '../../src/tools/workflows.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

describe('scan_sensitive_data', () => {
  it('returns counts and redacted examples without raw sensitive values', async () => {
    const r = await scanSensitiveData({
      path_prefix: '_shared/context/alfa',
      include_examples: true,
      limit: 10,
    }, ctx);

    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.counts.phone_like.occurrences).toBeGreaterThanOrEqual(1);
    expect(sc.counts.whatsapp_jid.occurrences).toBeGreaterThanOrEqual(1);
    expect(sc.counts.email.occurrences).toBeGreaterThanOrEqual(1);
    expect(sc.counts.cpf_like.occurrences).toBeGreaterThanOrEqual(1);
    expect(sc.counts.secret_keyword.occurrences).toBeGreaterThanOrEqual(1);

    const serialized = JSON.stringify(sc);
    expect(serialized).toContain('[PHONE_REDACTED]');
    expect(serialized).toContain('[WHATSAPP_JID_REDACTED]');
    expect(serialized).toContain('[EMAIL_REDACTED]');
    expect(serialized).toContain('[CPF_REDACTED]');
    expect(serialized).toContain('[SECRET_REDACTED]');
    expect(serialized).not.toContain('5511999999999');
    expect(serialized).not.toContain('5511988887777@s.whatsapp.net');
    expect(serialized).not.toContain('sample@example.com');
    expect(serialized).not.toContain('123.456.789-09');
    expect(serialized).not.toContain('${TEST_API_KEY}');
  });
});
