import pg from 'pg';
import type { VaultIndex } from '../index.js';
import { createOpenAIEmbeddingProvider } from './openai-embedding.js';
import { PostgresSemanticStore } from './postgres-store.js';
import { SemanticMemoryService } from './service.js';
import type { EmbeddingProvider, SemanticMemoryServiceOptions } from './types.js';

export interface SemanticMemoryConfig extends SemanticMemoryServiceOptions {
  enabled: boolean;
  databaseUrl: string;
  openaiApiKey: string;
}

export interface SemanticMemoryServerConfig {
  semantic: SemanticMemoryConfig;
}

export interface SemanticPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end?: () => Promise<void> | void;
}

export interface SemanticMemoryFactoryDeps {
  vaultRoot: string;
  index: VaultIndex;
  makePool?: (databaseUrl: string) => SemanticPool;
  makeEmbeddingProvider?: (config: SemanticMemoryConfig) => EmbeddingProvider;
  onMigrate?: () => void;
}

export async function createSemanticMemoryFromConfig(
  config: SemanticMemoryServerConfig,
  deps: SemanticMemoryFactoryDeps,
): Promise<SemanticMemoryService | undefined> {
  const semantic = config.semantic;
  if (!semantic.enabled) return undefined;

  const ownedPool = deps.makePool === undefined;
  const pool = deps.makePool?.(semantic.databaseUrl)
    ?? new pg.Pool({ connectionString: semantic.databaseUrl });
  const embeddings = deps.makeEmbeddingProvider?.(semantic)
    ?? createOpenAIEmbeddingProvider(semantic.openaiApiKey, {
      model: semantic.embeddingModel,
      dimensions: semantic.embeddingDimensions,
    });
  const store = new PostgresSemanticStore(pool, { dimensions: semantic.embeddingDimensions });
  const service = new SemanticMemoryService({
    vaultRoot: deps.vaultRoot,
    index: deps.index,
    embeddings,
    store,
    options: semantic,
  });

  try {
    await service.migrate();
  } catch (error) {
    if (ownedPool) await pool.end?.();
    throw error;
  }
  deps.onMigrate?.();

  return service;
}
