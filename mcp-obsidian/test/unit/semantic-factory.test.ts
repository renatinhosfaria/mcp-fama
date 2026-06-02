import { describe, expect, it } from 'vitest';
import {
  createSemanticMemoryFromConfig,
  type SemanticMemoryConfig,
  type SemanticMemoryFactoryDeps,
  type SemanticMemoryServerConfig,
} from '../../src/vault/semantic/factory.js';
import type { VaultIndex } from '../../src/vault/index.js';

const fakeIndex = {} as VaultIndex;

const enabledSemanticConfig: SemanticMemoryConfig = {
  enabled: true,
  databaseUrl: 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian',
  openaiApiKey: 'sk-test',
  embeddingModel: 'text-embedding-3-large',
  embeddingDimensions: 3072,
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
});
