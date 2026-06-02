import { promises as fsp } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { IndexEntry, VaultIndex } from '../index.js';
import { computeIndexPolicy } from '../index-policy.js';
import { chunkMarkdownSections } from './chunker.js';
import type {
  EmbeddingProvider,
  SemanticIndexPathResult,
  SemanticMemoryServiceOptions,
  SemanticRebuildInput,
  SemanticRebuildResult,
  SemanticSearchInput,
  SemanticSearchResult,
  SemanticStore,
  SemanticStoredChunk,
} from './types.js';

export interface SemanticMemoryServiceDependencies {
  vaultRoot: string;
  index: VaultIndex;
  embeddings: EmbeddingProvider;
  store: SemanticStore;
  options: SemanticMemoryServiceOptions;
}

export class SemanticMemoryService {
  private readonly vaultRoot: string;
  private readonly index: VaultIndex;
  private readonly embeddings: EmbeddingProvider;
  private readonly store: SemanticStore;
  private readonly options: SemanticMemoryServiceOptions;

  constructor(deps: SemanticMemoryServiceDependencies) {
    this.vaultRoot = deps.vaultRoot;
    this.index = deps.index;
    this.embeddings = deps.embeddings;
    this.store = deps.store;
    this.options = deps.options;
  }

  async migrate(): Promise<void> {
    await this.store.migrate();
  }

  async indexPath(rel: string): Promise<SemanticIndexPathResult> {
    const entry = this.index.get(rel);
    if (entry === undefined) {
      await this.store.deletePath(rel);
      return { indexed: false, chunks: 0 };
    }

    const content = await fsp.readFile(path.join(this.vaultRoot, rel), 'utf8');
    const frontmatter = readLooseFrontmatter(content);
    const indexPolicy = computeIndexPolicy(rel, frontmatter ?? entry.frontmatter);
    if (entry.index_policy.vector === false || indexPolicy.vector === false) {
      await this.store.deletePath(rel);
      return { indexed: false, chunks: 0 };
    }

    const chunks = chunkMarkdownSections({
      path: rel,
      content,
      previewChars: this.options.previewChars,
      maxChunkChars: this.options.maxChunkChars,
    });
    const embeddings = await this.embeddings.embedTexts(chunks.map((chunk) => chunk.text));
    const storedChunks: SemanticStoredChunk[] = chunks.map((chunk, index) => ({
      path: chunk.path,
      chunk_index: chunk.chunk_index,
      heading: chunk.heading,
      heading_path: chunk.heading_path,
      preview: chunk.preview,
      content_hash: chunk.content_hash,
      embedding: embeddings[index],
      metadata: metadataForEntry(entry, frontmatter),
    }));

    await this.store.upsertChunks({
      path: rel,
      chunks: storedChunks,
      embeddingModel: this.options.embeddingModel,
      embeddingDimensions: this.options.embeddingDimensions,
    });

    return { indexed: true, chunks: storedChunks.length };
  }

  async rebuild(input: SemanticRebuildInput): Promise<SemanticRebuildResult> {
    const result: SemanticRebuildResult = { indexed: 0, skipped: 0, deleted: 0, errors: [] };
    let processed = 0;

    for (const entry of this.index.allEntries()) {
      if (input.limit !== undefined && processed >= input.limit) break;
      if (input.path !== undefined && !entry.path.startsWith(input.path)) {
        result.skipped += 1;
        continue;
      }
      if (entry.index_policy.vector === false) {
        result.skipped += 1;
        continue;
      }
      if (!await this.canRebuildEntry(input.asAgent, entry)) {
        result.skipped += 1;
        continue;
      }

      processed += 1;
      try {
        const indexed = await this.indexPath(entry.path);
        if (indexed.indexed) result.indexed += 1;
        else result.deleted += 1;
      } catch (error) {
        result.errors.push({ path: entry.path, error: errorMessage(error) });
      }
    }

    return result;
  }

  async search(input: SemanticSearchInput): Promise<SemanticSearchResult[]> {
    const minScore = input.minScore ?? this.options.minScore;
    const limit = Math.min(input.limit ?? this.options.maxResults, this.options.maxResults);
    const [queryEmbedding] = await this.embeddings.embedTexts([input.query]);
    const results = await this.store.search({
      queryEmbedding,
      queryText: input.query,
      minScore,
      limit,
      filter: input.filter,
      embeddingModel: this.options.embeddingModel,
    });

    return results
      .filter((result) => result.score >= minScore)
      .slice(0, limit);
  }

  async deletePath(rel: string): Promise<void> {
    await this.store.deletePath(rel);
  }

  private async canRebuildEntry(asAgent: string, entry: IndexEntry): Promise<boolean> {
    if (asAgent === 'vault_admin') return true;
    if (entry.owner === asAgent || entry.frontmatter?.author_agent === asAgent) return true;

    const content = await fsp.readFile(path.join(this.vaultRoot, entry.path), 'utf8');
    return readLooseFrontmatter(content)?.author_agent === asAgent;
  }
}

function metadataForEntry(
  entry: IndexEntry,
  frontmatter: Record<string, any> | null,
): SemanticStoredChunk['metadata'] {
  const fm = frontmatter ?? entry.frontmatter;

  return {
    owner: entry.owner,
    type: entry.type ?? stringOrNull(fm?.type),
    tags: entry.tags.length > 0 ? entry.tags : stringArray(fm?.tags),
    updated: entry.updated ?? stringOrNull(fm?.updated),
    author_agent: stringOrNull(fm?.author_agent),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLooseFrontmatter(content: string): Record<string, any> | null {
  if (!matter.test(content)) return null;
  return matter(content).data as Record<string, any>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
