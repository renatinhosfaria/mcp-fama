import { describe, expect, it } from 'vitest';
import { PostgresSemanticStore, serializeVectorForSql } from '../../src/vault/semantic/postgres-store.js';

describe('PostgresSemanticStore', () => {
  it('serializes vectors for pgvector parameters', () => {
    expect(serializeVectorForSql([0.1, -0.2, 3])).toBe('[0.1,-0.2,3]');
  });

  it('creates pgvector extension and semantic tables', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    };
    const store = new PostgresSemanticStore(pool as any, { dimensions: 3072 });

    await store.migrate();

    expect(queries.join('\n')).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(queries.join('\n')).toContain('CREATE TABLE IF NOT EXISTS semantic_chunks');
    expect(queries.join('\n')).toContain('embedding vector(3072)');
    expect(queries.join('\n')).toContain('note_type text');
    expect(queries.join('\n')).toContain('indexed_at timestamptz NOT NULL DEFAULT now()');
    expect(queries.join('\n')).toContain('ALTER TABLE semantic_chunks ADD COLUMN IF NOT EXISTS note_type text');
    expect(queries.join('\n')).toContain(
      'ALTER TABLE semantic_chunks ADD COLUMN IF NOT EXISTS indexed_at timestamptz NOT NULL DEFAULT now()',
    );
    expect(queries.join('\n')).toContain('DROP INDEX IF EXISTS semantic_chunks_path_model_idx');
    expect(queries.join('\n')).toContain('CREATE UNIQUE INDEX IF NOT EXISTS semantic_chunks_path_model_idx');
    expect(queries.join('\n')).toContain('ON semantic_chunks(path, chunk_index, embedding_model)');
    expect(queries.join('\n')).toContain('CREATE TABLE IF NOT EXISTS semantic_index_state');
    expect(queries.join('\n')).toContain('chunks_count integer NOT NULL');
    expect(queries.join('\n')).toContain('status text NOT NULL');
    expect(queries.join('\n')).toContain('error text');
    expect(queries.join('\n')).toContain(
      'ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS chunks_count integer NOT NULL DEFAULT 0',
    );
    expect(queries.join('\n')).toContain(
      "ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'indexed'",
    );
    expect(queries.join('\n')).toContain('ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS error text');
    expect(queries.join('\n')).toContain(
      'ALTER TABLE semantic_index_state ADD COLUMN IF NOT EXISTS indexed_at timestamptz NOT NULL DEFAULT now()',
    );

    const dropIndexPosition = queries.findIndex((sql) => sql.includes('DROP INDEX IF EXISTS semantic_chunks_path_model_idx'));
    const createUniqueIndexPosition = queries.findIndex((sql) =>
      sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS semantic_chunks_path_model_idx'),
    );
    expect(dropIndexPosition).toBeGreaterThan(-1);
    expect(createUniqueIndexPosition).toBeGreaterThan(dropIndexPosition);
  });

  it('upserts chunks with preview metadata and vector casts', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const pool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const store = new PostgresSemanticStore(pool as any, { dimensions: 2 });

    await store.upsertChunks({
      path: '_journal/alfa/a.md',
      chunks: [
        {
          path: '_journal/alfa/a.md',
          chunk_index: 0,
          heading: 'Atendimento',
          heading_path: ['Atendimento'],
          preview: 'Cliente pediu valores.',
          content_hash: 'hash',
          embedding: [0.1, 0.2],
          metadata: {
            owner: 'alfa',
            type: 'journal',
            tags: ['lead'],
            updated: '2026-05-11',
            author_agent: 'alfa',
          },
        },
      ],
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 2,
    });

    const combinedSql = calls.map((c) => c.sql).join('\n');
    expect(combinedSql).toContain('DELETE FROM semantic_chunks');
    expect(combinedSql).toContain('$8::vector');
    expect(calls.some((c) => c.params?.includes('[0.1,0.2]'))).toBe(true);

    const stateCall = calls.find((c) => c.sql.includes('INSERT INTO semantic_index_state'));
    expect(stateCall?.sql).toContain('chunks_count');
    expect(stateCall?.sql).toContain('status');
    expect(stateCall?.sql).toContain('error');
    expect(stateCall?.sql).toContain('indexed_at');
    expect(stateCall?.params).toEqual([
      '_journal/alfa/a.md',
      'hash',
      'text-embedding-3-large',
      2,
      1,
      'indexed',
      null,
    ]);
  });

  it('deletes chunks and index state for a path', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const pool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const store = new PostgresSemanticStore(pool as any, { dimensions: 2 });

    await store.deletePath('_journal/alfa/a.md');

    expect(calls.map((c) => c.sql).join('\n')).toContain('DELETE FROM semantic_chunks');
    expect(calls.map((c) => c.sql).join('\n')).toContain('DELETE FROM semantic_index_state');
    expect(calls.every((c) => c.params?.[0] === '_journal/alfa/a.md')).toBe(true);
  });

  it('rejects chunks when embedding dimensions differ from the store schema', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const store = new PostgresSemanticStore(pool as any, { dimensions: 2 });

    await expect(
      store.upsertChunks({
        path: '_journal/alfa/a.md',
        chunks: [],
        embeddingModel: 'text-embedding-3-large',
        embeddingDimensions: 3,
      }),
    ).rejects.toThrow(/embedding dimensions/i);
  });

  it('searches with vector parameters, filters, and maps rows', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const pool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              path: '_journal/alfa/a.md',
              chunk_id: '_journal/alfa/a.md#text-embedding-3-large#0',
              chunk_index: 0,
              heading: 'Atendimento',
              heading_path: ['Atendimento'],
              preview: 'Cliente pediu valores.',
              owner: 'alfa',
              note_type: 'journal',
              tags: ['lead'],
              score: '0.92',
              source: 'hybrid',
            },
          ],
        };
      },
    };
    const store = new PostgresSemanticStore(pool as any, { dimensions: 2 });

    const result = await store.search({
      queryEmbedding: [0.1, 0.2],
      queryText: 'cliente lead',
      minScore: 0.75,
      limit: 5,
      filter: {
        owner: ['alfa', 'beta'],
        type: 'journal',
        tag: 'lead',
        excludePath: '_journal/alfa/old.md',
      },
      embeddingModel: 'text-embedding-3-large',
    });

    expect(calls[0].sql).toContain('embedding <=> $1::vector');
    expect(calls[0].sql).toContain('embedding_model = $2');
    expect(calls[0].sql).toContain('owner = ANY');
    expect(calls[0].sql).toContain('note_type');
    expect(calls[0].sql).toContain('$6 = ANY(tags)');
    expect(calls[0].params).toEqual([
      '[0.1,0.2]',
      'text-embedding-3-large',
      ['cliente', 'lead'],
      ['alfa', 'beta'],
      'journal',
      'lead',
      '_journal/alfa/old.md',
      0.75,
      5,
    ]);
    expect(result).toEqual([
      {
        path: '_journal/alfa/a.md',
        chunk_id: '_journal/alfa/a.md#text-embedding-3-large#0',
        chunk_index: 0,
        heading: 'Atendimento',
        heading_path: ['Atendimento'],
        preview: 'Cliente pediu valores.',
        owner: 'alfa',
        type: 'journal',
        tags: ['lead'],
        score: 0.92,
        source: 'hybrid',
      },
    ]);
  });
});
