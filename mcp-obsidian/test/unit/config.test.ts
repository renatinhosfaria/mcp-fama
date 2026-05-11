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
    process.env.API_KEY = '';
    await expect(import('../../src/config.js?t=' + Date.now())).rejects.toThrow(/API_KEY/);
  });

  it('throws if VAULT_PATH is missing', async () => {
    process.env.API_KEY = 'x';
    process.env.VAULT_PATH = '';
    await expect(import('../../src/config.js?t=' + Date.now())).rejects.toThrow(/VAULT_PATH/);
  });

  it('returns defaults for optional fields', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/v';
    const { config } = await import('../../src/config.js?t=' + Date.now());
    expect(config.port).toBe(3201);
    expect(config.rateLimitRpm).toBe(300);
  });

  it('Schema v1 compatibility config defaults', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/tmp';
    delete process.env.LEGACY_TOOL_MODE;
    delete process.env.HUMAN_VERIFIERS;
    delete process.env.DEFAULT_AGENT_SOURCE;
    delete process.env.DEFAULT_DATE_STYLE;
    vi.resetModules();
    const mod = await import('../../src/config.js?t=schema-v1-defaults-' + Date.now());
    expect(mod.config.legacyToolMode).toBe('redirect');
    expect(mod.config.humanVerifiers).toEqual([]);
    expect(mod.config.defaultAgentSource).toBe('agent-generated');
    expect(mod.config.defaultDateStyle).toBe('yyyy-mm-dd');
  });

  it('accepts Schema v1 compatibility config overrides', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/tmp';
    process.env.LEGACY_TOOL_MODE = 'error';
    process.env.HUMAN_VERIFIERS = 'Renato Faria, Maria';
    process.env.DEFAULT_AGENT_SOURCE = 'human-authored';
    process.env.DEFAULT_DATE_STYLE = 'dd/mm/yyyy';
    vi.resetModules();
    const mod = await import('../../src/config.js?t=schema-v1-overrides-' + Date.now());
    expect(mod.config.legacyToolMode).toBe('error');
    expect(mod.config.humanVerifiers).toEqual(['Renato Faria', 'Maria']);
    expect(mod.config.defaultAgentSource).toBe('human-authored');
    expect(mod.config.defaultDateStyle).toBe('dd/mm/yyyy');
  });

  it('throws a helpful error for invalid LEGACY_TOOL_MODE', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/tmp';
    process.env.LEGACY_TOOL_MODE = 'warn';
    vi.resetModules();
    await expect(import('../../src/config.js?t=schema-v1-invalid-' + Date.now()))
      .rejects.toThrow('LEGACY_TOOL_MODE must be redirect or error');
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
