import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.resetModules();
    process.env = originalEnv;
  });

  it('throws if API_KEY is missing', async () => {
    delete process.env.API_KEY;
    await expect(import('../../src/config.js?t=' + Date.now())).rejects.toThrow(/API_KEY/);
  });

  it('throws if VAULT_PATH is missing', async () => {
    process.env.API_KEY = 'x';
    delete process.env.VAULT_PATH;
    await expect(import('../../src/config.js?t=' + Date.now())).rejects.toThrow(/VAULT_PATH/);
  });

  it('returns defaults for optional fields', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/v';
    const { config } = await import('../../src/config.js?t=' + Date.now());
    expect(config.port).toBe(3201);
    expect(config.rateLimitRpm).toBe(300);
    expect(config.gitLockfile).toBe('/tmp/brain-sync.lock');
    expect(config.strictWikilinks).toBe(false);
  });
});
