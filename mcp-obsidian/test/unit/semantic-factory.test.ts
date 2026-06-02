import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSemanticMemoryFromConfig,
  type SemanticMemoryConfig,
  type SemanticMemoryFactoryDeps,
  type SemanticMemoryServerConfig,
} from '../../src/vault/semantic/factory.js';
import type { VaultIndex } from '../../src/vault/index.js';

const pgPools = vi.hoisted(() => ({
  failMigrate: false,
  instances: [] as Array<{
    connectionString: string;
    endCalls: number;
    query: () => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  }>,
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      readonly connectionString: string;
      endCalls = 0;

      constructor(options: { connectionString: string }) {
        this.connectionString = options.connectionString;
        pgPools.instances.push(this);
      }

      async query(): Promise<{ rows: unknown[] }> {
        if (pgPools.failMigrate) throw new Error('migration failed');
        return { rows: [] };
      }

      async end(): Promise<void> {
        this.endCalls += 1;
      }
    },
  },
}));

const fakeIndex = {} as VaultIndex;

const enabledSemanticConfig: SemanticMemoryConfig = {
  enabled: true,
  databaseUrl: 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian',
  openaiApiKey: 'sk-test',
  embeddingModel: 'text-embedding-3-large',
  embeddingDimensions: 1536,
  previewChars: 600,
  minScore: 0.75,
  maxResults: 5,
};

const disabledConfig: SemanticMemoryServerConfig = {
  semantic: {
    ...enabledSemanticConfig,
    enabled: false,
  },
};

function enabledConfig(semantic: SemanticMemoryConfig = enabledSemanticConfig): SemanticMemoryServerConfig {
  return { semantic };
}

function fakePool(): ReturnType<NonNullable<SemanticMemoryFactoryDeps['makePool']>> {
  return { query: async () => ({ rows: [] }) };
}

function baseDeps(overrides: Partial<SemanticMemoryFactoryDeps> = {}): SemanticMemoryFactoryDeps {
  return {
    vaultRoot: '/tmp/vault',
    index: fakeIndex,
    ...overrides,
  };
}

describe('createSemanticMemoryFromConfig', () => {
  beforeEach(() => {
    pgPools.failMigrate = false;
    pgPools.instances.length = 0;
  });

  it('returns undefined when semantic memory is disabled', async () => {
    const service = await createSemanticMemoryFromConfig(disabledConfig, baseDeps());

    expect(service).toBeUndefined();
  });

  it('does not create dependencies when semantic memory is disabled', async () => {
    let poolCalls = 0;
    let providerCalls = 0;

    const service = await createSemanticMemoryFromConfig(disabledConfig, baseDeps({
      makePool: () => {
        poolCalls += 1;
        return fakePool();
      },
      makeEmbeddingProvider: () => {
        providerCalls += 1;
        return { embedTexts: async () => [] };
      },
    }));

    expect(service).toBeUndefined();
    expect(poolCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('creates and migrates semantic memory when enabled', async () => {
    const migrated: string[] = [];
    const service = await createSemanticMemoryFromConfig(enabledConfig(), baseDeps({
      makePool: () => fakePool(),
      makeEmbeddingProvider: () => ({ embedTexts: async () => [] }),
      onMigrate: () => migrated.push('migrated'),
    }));

    expect(service).toBeDefined();
    expect(migrated).toEqual(['migrated']);
  });

  it('passes semantic configuration to dependency factories when enabled', async () => {
    const databaseUrls: string[] = [];
    const providerConfigs: SemanticMemoryConfig[] = [];
    const semantic = enabledSemanticConfig;

    await createSemanticMemoryFromConfig(enabledConfig(semantic), baseDeps({
      makePool: (databaseUrl: string) => {
        databaseUrls.push(databaseUrl);
        return fakePool();
      },
      makeEmbeddingProvider: (config: SemanticMemoryConfig) => {
        providerConfigs.push(config);
        return { embedTexts: async () => [] };
      },
    }));

    expect(databaseUrls).toEqual(['postgresql://mcp:mcp@localhost:5432/mcp_obsidian']);
    expect(providerConfigs).toEqual([semantic]);
  });

  it('closes internally created pool when migration fails', async () => {
    pgPools.failMigrate = true;

    await expect(createSemanticMemoryFromConfig(enabledConfig(), baseDeps({
      makeEmbeddingProvider: () => ({ embedTexts: async () => [] }),
    }))).rejects.toThrow('migration failed');

    expect(pgPools.instances).toHaveLength(1);
    expect(pgPools.instances[0].connectionString).toBe(enabledSemanticConfig.databaseUrl);
    expect(pgPools.instances[0].endCalls).toBe(1);
  });

  it('does not close injected pool when migration fails', async () => {
    let endCalls = 0;
    const injectedPool = {
      query: async () => {
        throw new Error('migration failed');
      },
      end: async () => {
        endCalls += 1;
      },
    };

    await expect(createSemanticMemoryFromConfig(enabledConfig(), baseDeps({
      makePool: () => injectedPool,
      makeEmbeddingProvider: () => ({ embedTexts: async () => [] }),
    }))).rejects.toThrow('migration failed');

    expect(endCalls).toBe(0);
  });
});
