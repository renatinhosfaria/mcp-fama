import type {
  SemanticSearchFilter,
  SemanticSearchResult,
  SemanticStore,
  SemanticStoredChunk,
} from './types.js';

interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface PostgresSemanticStoreOptions {
  dimensions: number;
}

interface SearchRow {
  path: string;
  chunk_id: string;
  chunk_index: number;
  heading: string | null;
  heading_path: string[] | null;
  preview: string | null;
  owner: string | null;
  note_type: string | null;
  tags: string[] | null;
  score: number | string;
  source: 'vector' | 'hybrid';
}

export function serializeVectorForSql(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

export class PostgresSemanticStore implements SemanticStore {
  private readonly dimensions: number;

  constructor(
    private readonly pool: QueryablePool,
    options: PostgresSemanticStoreOptions,
  ) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new Error('Semantic store dimensions must be a positive integer');
    }
    this.dimensions = options.dimensions;
  }

  async migrate(): Promise<void> {
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS semantic_chunks (
        path text NOT NULL,
        chunk_id text PRIMARY KEY,
        chunk_index integer NOT NULL,
        heading text NOT NULL,
        heading_path text[] NOT NULL DEFAULT '{}',
        preview text NOT NULL,
        content_hash text NOT NULL,
        embedding_model text NOT NULL,
        embedding_dimensions integer NOT NULL,
        embedding vector(${this.dimensions}) NOT NULL,
        owner text,
        note_type text,
        tags text[] NOT NULL DEFAULT '{}',
        updated text,
        author_agent text,
        indexed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS semantic_index_state (
        path text PRIMARY KEY,
        content_hash text NOT NULL,
        embedding_model text NOT NULL,
        embedding_dimensions integer NOT NULL,
        chunks_count integer NOT NULL,
        status text NOT NULL,
        error text,
        indexed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query('ALTER TABLE semantic_chunks ADD COLUMN IF NOT EXISTS note_type text');
    await this.pool.query(
      'ALTER TABLE semantic_chunks ADD COLUMN IF NOT EXISTS indexed_at timestamptz NOT NULL DEFAULT now()',
    );
    await this.pool.query(
      'ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS chunks_count integer NOT NULL DEFAULT 0',
    );
    await this.pool.query(
      "ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'indexed'",
    );
    await this.pool.query('ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS error text');
    await this.pool.query(
      'ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS indexed_at timestamptz NOT NULL DEFAULT now()',
    );
    await this.pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'semantic_chunks' AND column_name = 'type'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'semantic_chunks' AND column_name = 'note_type'
        ) THEN
          EXECUTE 'UPDATE semantic_chunks SET note_type = "type" WHERE note_type IS NULL';
        END IF;
      END $$;
    `);
    await this.pool.query('DROP INDEX IF EXISTS semantic_chunks_path_model_idx');
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS semantic_chunks_path_model_idx
      ON semantic_chunks(path, chunk_index, embedding_model)
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS semantic_chunks_owner_type_idx ON semantic_chunks (owner, note_type)',
    );
    await this.pool.query('CREATE INDEX IF NOT EXISTS semantic_chunks_tags_idx ON semantic_chunks USING gin (tags)');
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS semantic_chunks_embedding_idx
      ON semantic_chunks USING hnsw (embedding vector_cosine_ops)
    `);
  }

  async upsertChunks(input: {
    path: string;
    chunks: SemanticStoredChunk[];
    embeddingModel: string;
    embeddingDimensions: number;
  }): Promise<void> {
    if (input.embeddingDimensions !== this.dimensions) {
      throw new Error(
        `Embedding dimensions mismatch: store uses ${this.dimensions}, input requested ${input.embeddingDimensions}`,
      );
    }

    await this.pool.query('DELETE FROM semantic_chunks WHERE path = $1 AND embedding_model = $2', [
      input.path,
      input.embeddingModel,
    ]);

    for (const chunk of input.chunks) {
      const chunkId = `${chunk.path}#${input.embeddingModel}#${chunk.chunk_index}`;
      await this.pool.query(
        `
          INSERT INTO semantic_chunks (
            path,
            chunk_id,
            chunk_index,
            heading,
            heading_path,
            preview,
            content_hash,
            embedding,
            embedding_model,
            embedding_dimensions,
            owner,
            note_type,
            tags,
            updated,
            author_agent,
            indexed_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8::vector,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            now()
          )
          ON CONFLICT (chunk_id) DO UPDATE SET
            heading = EXCLUDED.heading,
            heading_path = EXCLUDED.heading_path,
            preview = EXCLUDED.preview,
            content_hash = EXCLUDED.content_hash,
            embedding = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model,
            embedding_dimensions = EXCLUDED.embedding_dimensions,
            owner = EXCLUDED.owner,
            note_type = EXCLUDED.note_type,
            tags = EXCLUDED.tags,
            updated = EXCLUDED.updated,
            author_agent = EXCLUDED.author_agent,
            indexed_at = now()
        `,
        [
          chunk.path,
          chunkId,
          chunk.chunk_index,
          chunk.heading,
          chunk.heading_path,
          chunk.preview,
          chunk.content_hash,
          serializeVectorForSql(chunk.embedding),
          input.embeddingModel,
          this.dimensions,
          chunk.metadata.owner,
          chunk.metadata.type,
          chunk.metadata.tags,
          chunk.metadata.updated,
          chunk.metadata.author_agent,
        ],
      );
    }

    const stateHash = input.chunks.map((chunk) => chunk.content_hash).join(':');
    await this.pool.query(
      `
        INSERT INTO semantic_index_state (
          path,
          content_hash,
          embedding_model,
          embedding_dimensions,
          chunks_count,
          status,
          error,
          indexed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT (path) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          embedding_model = EXCLUDED.embedding_model,
          embedding_dimensions = EXCLUDED.embedding_dimensions,
          chunks_count = EXCLUDED.chunks_count,
          status = EXCLUDED.status,
          error = EXCLUDED.error,
          indexed_at = now()
      `,
      [input.path, stateHash, input.embeddingModel, this.dimensions, input.chunks.length, 'indexed', null],
    );
  }

  async deletePath(path: string): Promise<void> {
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '') || path;
    await this.pool.query("DELETE FROM semantic_chunks WHERE path = $1 OR path LIKE $1 || '/%'", [normalizedPath]);
    await this.pool.query("DELETE FROM semantic_index_state WHERE path = $1 OR path LIKE $1 || '/%'", [normalizedPath]);
  }

  async search(input: {
    queryEmbedding: number[];
    queryText: string;
    minScore: number;
    limit: number;
    filter?: SemanticSearchFilter;
    embeddingModel: string;
  }): Promise<SemanticSearchResult[]> {
    const params: unknown[] = [serializeVectorForSql(input.queryEmbedding), input.embeddingModel, tokenizeQuery(input.queryText)];
    const filters = ['embedding_model = $2'];
    addFilter(filters, params, input.filter);
    const minScorePlaceholder = `$${params.push(input.minScore)}`;
    const limitPlaceholder = `$${params.push(input.limit)}`;
    const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      WITH ranked AS (
        SELECT
          path,
          chunk_id,
          chunk_index,
          heading,
          heading_path,
          preview,
          owner,
          note_type,
          tags,
          LEAST(
            1.0,
            (1 - (embedding <=> $1::vector)) +
            CASE
              WHEN cardinality($3::text[]) = 0 THEN 0
              WHEN lower(coalesce(preview, '') || ' ' || coalesce(path, '') || ' ' || coalesce(heading, '') || ' ' || array_to_string(tags, ' '))
                LIKE ANY (SELECT '%' || lower(term) || '%' FROM unnest($3::text[]) AS term)
              THEN 0.05
              ELSE 0
            END
          ) AS score,
          CASE WHEN cardinality($3::text[]) = 0 THEN 'vector' ELSE 'hybrid' END AS source
        FROM semantic_chunks
        ${whereSql}
      )
      SELECT *
      FROM ranked
      WHERE score >= ${minScorePlaceholder}
      ORDER BY score DESC
      LIMIT ${limitPlaceholder}
    `;

    const result = await this.pool.query(sql, params);
    return (result.rows as SearchRow[]).map((row) => ({
      path: row.path,
      chunk_id: row.chunk_id,
      chunk_index: row.chunk_index,
      heading: row.heading ?? '',
      heading_path: row.heading_path ?? [],
      preview: row.preview ?? '',
      owner: row.owner,
      type: row.note_type,
      tags: row.tags ?? [],
      score: Number(row.score),
      source: row.source,
    }));
  }
}

function addFilter(filters: string[], params: unknown[], filter: SemanticSearchFilter | undefined): void {
  if (!filter) {
    return;
  }

  if (filter.path !== undefined) {
    filters.push(`path = $${params.push(filter.path)}`);
  }

  if (filter.owner !== undefined) {
    if (Array.isArray(filter.owner)) {
      filters.push(`owner = ANY($${params.push(filter.owner)}::text[])`);
    } else {
      filters.push(`owner = $${params.push(filter.owner)}`);
    }
  }

  if (filter.type !== undefined) {
    filters.push(`note_type = $${params.push(filter.type)}`);
  }

  if (filter.tag !== undefined) {
    filters.push(`$${params.push(filter.tag)} = ANY(tags)`);
  }

  if (filter.excludePath !== undefined) {
    filters.push(`path <> $${params.push(filter.excludePath)}`);
  }
}

function tokenizeQuery(queryText: string): string[] {
  return queryText
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 12);
}
