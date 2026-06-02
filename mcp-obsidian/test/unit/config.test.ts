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

  it('disables semantic memory by default', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/v';
    delete process.env.SEMANTIC_ENABLED;
    delete process.env.SEMANTIC_DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    const { config } = await import('../../src/config.js?t=semantic-defaults-' + Date.now());
    expect(config.semantic.enabled).toBe(false);
    expect(config.semantic.embeddingModel).toBe('text-embedding-3-large');
    expect(config.semantic.maxResults).toBe(5);
    expect(config.semantic.minScore).toBe(0.75);
    expect(config.semantic.previewChars).toBe(600);
  });

  it('requires semantic database URL and OpenAI key when semantic memory is enabled', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/v';
    process.env.SEMANTIC_ENABLED = 'true';
    delete process.env.SEMANTIC_DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    await expect(import('../../src/config.js?t=semantic-required-' + Date.now()))
      .rejects.toThrow('SEMANTIC_DATABASE_URL');
  });

  it('treats blank semantic database URL as missing when semantic memory is enabled', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/v';
    process.env.SEMANTIC_ENABLED = 'true';
    process.env.SEMANTIC_DATABASE_URL = '   ';
    process.env.OPENAI_API_KEY = 'sk-test';
    await expect(import('../../src/config.js?t=semantic-blank-database-' + Date.now()))
      .rejects.toThrow('SEMANTIC_DATABASE_URL');
  });

  it('treats blank OpenAI key as missing when semantic memory is enabled', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/v';
    process.env.SEMANTIC_ENABLED = 'true';
    process.env.SEMANTIC_DATABASE_URL = 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian';
    process.env.OPENAI_API_KEY = '   ';
    await expect(import('../../src/config.js?t=semantic-blank-openai-key-' + Date.now()))
      .rejects.toThrow('OPENAI_API_KEY');
  });

  it('accepts semantic memory overrides', async () => {
    process.env.API_KEY = 'k';
    process.env.VAULT_PATH = '/v';
    process.env.SEMANTIC_ENABLED = 'true';
    process.env.SEMANTIC_DATABASE_URL = 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.SEMANTIC_EMBEDDING_MODEL = 'text-embedding-3-large';
    process.env.SEMANTIC_EMBEDDING_DIMENSIONS = '3072';
    process.env.SEMANTIC_MIN_SCORE = '0.82';
    process.env.SEMANTIC_MAX_RESULTS = '3';
    process.env.SEMANTIC_PREVIEW_CHARS = '400';
    const { config } = await import('../../src/config.js?t=semantic-overrides-' + Date.now());
    expect(config.semantic).toEqual({
      enabled: true,
      databaseUrl: 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian',
      openaiApiKey: 'sk-test',
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 3072,
      minScore: 0.82,
      maxResults: 3,
      previewChars: 400,
    });
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
