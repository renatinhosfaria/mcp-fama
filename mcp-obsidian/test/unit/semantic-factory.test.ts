import { describe, expect, it } from 'vitest';
import { createSemanticMemoryFromConfig } from '../../src/vault/semantic/factory.js';

describe('createSemanticMemoryFromConfig', () => {
  it('returns undefined when semantic memory is disabled', async () => {
    const service = await createSemanticMemoryFromConfig({
      semantic: { enabled: false },
    } as any, {} as any);

    expect(service).toBeUndefined();
  });

  it('does not create dependencies when semantic memory is disabled', async () => {
    let poolCalls = 0;
    let providerCalls = 0;

    const service = await createSemanticMemoryFromConfig({
      semantic: { enabled: false },
    } as any, {
      makePool: () => {
        poolCalls += 1;
        return { query: async () => ({ rows: [] }) };
      },
      makeEmbeddingProvider: () => {
        providerCalls += 1;
        return { embedTexts: async () => [] };
      },
    } as any);

    expect(service).toBeUndefined();
    expect(poolCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('creates and migrates semantic memory when enabled', async () => {
    const migrated: string[] = [];
    const service = await createSemanticMemoryFromConfig({
      semantic: {
        enabled: true,
        databaseUrl: 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian',
        openaiApiKey: 'sk-test',
        embeddingModel: 'text-embedding-3-large',
        embeddingDimensions: 3072,
        previewChars: 600,
        minScore: 0.75,
        maxResults: 5,
      },
    } as any, {
      vaultRoot: '/tmp/vault',
      index: {} as any,
      makePool: () => ({ query: async () => ({ rows: [] }) }),
      makeEmbeddingProvider: () => ({ embedTexts: async () => [] }),
      onMigrate: () => migrated.push('migrated'),
    } as any);

    expect(service).toBeDefined();
    expect(migrated).toEqual(['migrated']);
  });

  it('passes semantic configuration to dependency factories when enabled', async () => {
    const databaseUrls: string[] = [];
    const providerConfigs: unknown[] = [];
    const semantic = {
      enabled: true,
      databaseUrl: 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian',
      openaiApiKey: 'sk-test',
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 3072,
      previewChars: 600,
      minScore: 0.75,
      maxResults: 5,
    };

    await createSemanticMemoryFromConfig({
      semantic,
    } as any, {
      vaultRoot: '/tmp/vault',
      index: {} as any,
      makePool: (databaseUrl: string) => {
        databaseUrls.push(databaseUrl);
        return { query: async () => ({ rows: [] }) };
      },
      makeEmbeddingProvider: (config: unknown) => {
        providerConfigs.push(config);
        return { embedTexts: async () => [] };
      },
    } as any);

    expect(databaseUrls).toEqual(['postgresql://mcp:mcp@localhost:5432/mcp_obsidian']);
    expect(providerConfigs).toEqual([semantic]);
  });
});
