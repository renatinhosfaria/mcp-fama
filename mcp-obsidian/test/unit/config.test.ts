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
  });
});

describe('config — sync worker env vars', () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it('SYNC_INTERVAL_MS defaults to 30000 when unset', async () => {
    delete process.env.SYNC_INTERVAL_MS;
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    vi.resetModules();
    const mod = await import('../../src/config.js?fresh1');
    expect(mod.config.syncIntervalMs).toBe(30000);
  });

  it('SYNC_ENABLED defaults to true when unset', async () => {
    delete process.env.SYNC_ENABLED;
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    vi.resetModules();
    const mod = await import('../../src/config.js?fresh2');
    expect(mod.config.syncEnabled).toBe(true);
  });

  it('SYNC_ENABLED=false disables', async () => {
    process.env.SYNC_ENABLED = 'false';
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    vi.resetModules();
    const mod = await import('../../src/config.js?fresh3');
    expect(mod.config.syncEnabled).toBe(false);
  });

  it('GIT_REMOTE / GIT_BRANCH defaults', async () => {
    delete process.env.GIT_REMOTE; delete process.env.GIT_BRANCH;
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/tmp';
    vi.resetModules();
    const mod = await import('../../src/config.js?fresh4');
    expect(mod.config.gitRemote).toBe('origin');
    expect(mod.config.gitBranch).toBe('main');
  });
});
