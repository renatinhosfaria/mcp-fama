export interface SemanticChunk {
  path: string;
  chunk_index: number;
  heading: string;
  heading_path: string[];
  text: string;
  preview: string;
  content_hash: string;
}

export interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export interface SemanticChunkMetadata {
  owner: string | null;
  type: string | null;
  tags: string[];
  updated: string | null;
  author_agent: string | null;
}

export interface SemanticStoredChunk extends Omit<SemanticChunk, 'text'> {
  embedding: number[];
  metadata: SemanticChunkMetadata;
}

export interface SemanticSearchFilter {
  path?: string;
  owner?: string | string[];
  type?: string;
  tag?: string;
  excludePath?: string;
}

export interface SemanticSearchResult {
  path: string;
  chunk_id: string;
  chunk_index: number;
  heading: string;
  heading_path: string[];
  preview: string;
  owner: string | null;
  type: string | null;
  tags: string[];
  score: number;
  source: 'vector' | 'hybrid';
}

export interface SemanticStore {
  migrate(): Promise<void>;
  upsertChunks(input: {
    path: string;
    chunks: SemanticStoredChunk[];
    embeddingModel: string;
    embeddingDimensions: number;
  }): Promise<void>;
  deletePath(path: string): Promise<void>;
  search(input: {
    queryEmbedding: number[];
    queryText: string;
    minScore: number;
    limit: number;
    filter?: SemanticSearchFilter;
    embeddingModel: string;
  }): Promise<SemanticSearchResult[]>;
}

export interface SemanticMemoryServiceOptions {
  embeddingModel: string;
  embeddingDimensions: number;
  previewChars: number;
  minScore: number;
  maxResults: number;
  maxChunkChars?: number;
}

export interface SemanticIndexPathResult {
  indexed: boolean;
  chunks: number;
}

export interface SemanticRebuildInput {
  asAgent: string;
  path?: string;
  limit?: number;
  force?: boolean;
}

export interface SemanticRebuildResult {
  indexed: number;
  skipped: number;
  deleted: number;
  errors: Array<{ path: string; error: string }>;
}

export interface SemanticSearchInput {
  query: string;
  minScore?: number;
  limit?: number;
  filter?: SemanticSearchFilter;
}
