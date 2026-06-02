# Semantic Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic semantic memory to `mcp-obsidian`, using a dedicated Postgres/pgvector database and OpenAI `text-embedding-3-large`, so AI agents receive relevant vault context and write warnings without turning the Obsidian vault itself into a database.

**Architecture:** Keep the current vault index as the source of truth for files, ownership, metadata, trust, and routing. Add an optional semantic service to `ToolCtx`; when enabled it chunks eligible Markdown notes, stores embeddings plus metadata and 600-character previews in Postgres, and enriches MCP tool responses with `semantic_memory` for reads and `semantic_warnings` for writes. The feature is disabled by default and all semantic failures are non-blocking except explicit admin/search tools.

**Tech Stack:** TypeScript, Vitest, OpenAI embeddings API via `openai`, Postgres via `pg`, pgvector extension, existing `VaultIndex`, existing MCP tool registry, Docker Compose.

---

## Ground Rules

- Use @superpowers:test-driven-development for every production behavior.
- Do not write production code before the failing test for that behavior has been run and observed failing.
- Do not call OpenAI or a real Postgres database in unit tests. Use fake embedding providers and fake stores.
- Keep semantic memory disabled by default so existing deploys and tests keep working without Postgres or `OPENAI_API_KEY`.
- Store only metadata, embeddings, and a 600-character preview in Postgres. Do not store full note/chunk content outside the vault.
- Respect the user-approved defaults:
  - Embedding model: `text-embedding-3-large`
  - Dedicated Postgres for `mcp-obsidian`
  - Include `_journal` from the beginning
  - Max 5 automatic memory/warning items
  - Chunk by Markdown sections
  - Similarity threshold: `0.75`
  - Rebuild via admin tool first, background worker later
  - Any agent may rebuild own/authored scope; `vault_admin` may rebuild globally

## Pre-Flight Verification

Run from:

```bash
cd /root/.config/superpowers/worktrees/mcp-fama/mcp-obsidian-semantic-memory/mcp-obsidian
```

Baseline command:

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test
npm run typecheck
```

Expected:

- `43 Test Files ... passed`
- `420 Tests ... passed`
- `npm run typecheck` exits `0`

---

### Task 1: Include Journals In Vector Index Policy

**Files:**
- Modify: `test/unit/index-policy.test.ts`
- Modify: `src/vault/index-policy.ts`

**Step 1: Write the failing test**

Update the existing journal policy test:

```ts
it('enables vector and graph indexes for journal notes', () => {
  expect(computeIndexPolicy('_journal/alfa/2026-05-11-note.md', {})).toEqual({ vector: true, graph: true });
});
```

**Step 2: Run test to verify it fails**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/index-policy.test.ts
```

Expected: FAIL because `_journal` currently returns `{ vector: false, graph: true }`.

**Step 3: Implement the minimal policy change**

Add `_journal` to the vector-enabled folder set:

```ts
const VECTOR_AND_GRAPH_FOLDERS = new Set(['_entities', '_hubs', '_decisions', '_runbooks', '_journal']);
```

Remove the old special-case branch for `_journal` if it becomes unreachable or contradictory.

**Step 4: Run test to verify it passes**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/index-policy.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/index-policy.test.ts src/vault/index-policy.ts
git commit -m "feat: include journals in semantic index policy"
```

---

### Task 2: Semantic Runtime Config

**Files:**
- Modify: `test/unit/config.test.ts`
- Modify: `src/config.ts`

**Step 1: Write failing config tests**

Add tests under `describe('config - semantic memory env vars', ...)`:

```ts
it('semantic memory is disabled by default', async () => {
  process.env.API_KEY = 'k';
  process.env.VAULT_PATH = '/tmp';
  delete process.env.SEMANTIC_ENABLED;
  vi.resetModules();

  const mod = await import('../../src/config.js?t=semantic-defaults-' + Date.now());

  expect(mod.config.semantic.enabled).toBe(false);
  expect(mod.config.semantic.embeddingModel).toBe('text-embedding-3-large');
  expect(mod.config.semantic.maxResults).toBe(5);
  expect(mod.config.semantic.minScore).toBe(0.75);
  expect(mod.config.semantic.previewChars).toBe(600);
});

it('requires semantic database url and OpenAI key when semantic memory is enabled', async () => {
  process.env.API_KEY = 'k';
  process.env.VAULT_PATH = '/tmp';
  process.env.SEMANTIC_ENABLED = 'true';
  delete process.env.SEMANTIC_DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
  vi.resetModules();

  await expect(import('../../src/config.js?t=semantic-required-' + Date.now()))
    .rejects.toThrow(/SEMANTIC_DATABASE_URL/);
});

it('accepts semantic memory overrides', async () => {
  process.env.API_KEY = 'k';
  process.env.VAULT_PATH = '/tmp';
  process.env.SEMANTIC_ENABLED = 'true';
  process.env.SEMANTIC_DATABASE_URL = 'postgresql://mcp:mcp@localhost:5432/mcp_obsidian';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.SEMANTIC_EMBEDDING_MODEL = 'text-embedding-3-large';
  process.env.SEMANTIC_EMBEDDING_DIMENSIONS = '3072';
  process.env.SEMANTIC_MIN_SCORE = '0.82';
  process.env.SEMANTIC_MAX_RESULTS = '3';
  process.env.SEMANTIC_PREVIEW_CHARS = '400';
  vi.resetModules();

  const mod = await import('../../src/config.js?t=semantic-overrides-' + Date.now());

  expect(mod.config.semantic).toMatchObject({
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
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/config.test.ts
```

Expected: FAIL because `config.semantic` does not exist.

**Step 3: Implement minimal config**

Add parsing helpers if needed:

```ts
function parseOptionalInt(name: string, def: string): number {
  return parseInt(optional(name, def), 10);
}

function parseOptionalFloat(name: string, def: string): number {
  return parseFloat(optional(name, def));
}

function buildSemanticConfig() {
  const enabled = parseBool(optional('SEMANTIC_ENABLED', 'false'));
  const databaseUrl = optional('SEMANTIC_DATABASE_URL', '');
  const openaiApiKey = optional('OPENAI_API_KEY', '');
  if (enabled && !databaseUrl) throw new Error('SEMANTIC_DATABASE_URL is required when SEMANTIC_ENABLED=true');
  if (enabled && !openaiApiKey) throw new Error('OPENAI_API_KEY is required when SEMANTIC_ENABLED=true');
  return {
    enabled,
    databaseUrl,
    openaiApiKey,
    embeddingModel: optional('SEMANTIC_EMBEDDING_MODEL', 'text-embedding-3-large'),
    embeddingDimensions: parseOptionalInt('SEMANTIC_EMBEDDING_DIMENSIONS', '3072'),
    minScore: parseOptionalFloat('SEMANTIC_MIN_SCORE', '0.75'),
    maxResults: parseOptionalInt('SEMANTIC_MAX_RESULTS', '5'),
    previewChars: parseOptionalInt('SEMANTIC_PREVIEW_CHARS', '600'),
  };
}
```

Then add `semantic: buildSemanticConfig()` to exported `config`.

**Step 4: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/config.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 5: Commit**

```bash
git add test/unit/config.test.ts src/config.ts
git commit -m "feat: add semantic memory runtime config"
```

---

### Task 3: Markdown Section Chunker

**Files:**
- Create: `test/unit/semantic-chunker.test.ts`
- Create: `src/vault/semantic/chunker.ts`
- Create: `src/vault/semantic/types.ts`

**Step 1: Write failing chunker tests**

Create `test/unit/semantic-chunker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunkMarkdownSections } from '../../src/vault/semantic/chunker.js';

describe('chunkMarkdownSections', () => {
  it('chunks Markdown by heading sections and strips frontmatter', () => {
    const chunks = chunkMarkdownSections({
      path: '_journal/alfa/2026-05-11-atendimento.md',
      content: `---
type: journal
owner: alfa
---
# Atendimento
Cliente pediu tabela.

## Proximo passo
Enviar valores.`,
      previewChars: 600,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      path: '_journal/alfa/2026-05-11-atendimento.md',
      chunk_index: 0,
      heading: 'Atendimento',
      heading_path: ['Atendimento'],
      text: '# Atendimento\nCliente pediu tabela.',
      preview: '# Atendimento\nCliente pediu tabela.',
    });
    expect(chunks[1].heading_path).toEqual(['Atendimento', 'Proximo passo']);
    expect(chunks[1].content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps intro text before the first heading as a document section', () => {
    const chunks = chunkMarkdownSections({
      path: '_runbooks/alfa-operacao.md',
      content: 'Resumo inicial.\n\n# Operacao\nPasso 1.',
      previewChars: 600,
    });

    expect(chunks.map((c) => c.heading)).toEqual(['Document', 'Operacao']);
    expect(chunks[0].text).toBe('Resumo inicial.');
  });

  it('limits previews without truncating stored text', () => {
    const chunks = chunkMarkdownSections({
      path: '_entities/cliente.md',
      content: '# Cliente\n' + 'x'.repeat(1000),
      previewChars: 20,
    });

    expect(chunks[0].text.length).toBeGreaterThan(900);
    expect(chunks[0].preview.length).toBe(20);
  });

  it('splits very large sections on paragraph boundaries', () => {
    const chunks = chunkMarkdownSections({
      path: '_runbooks/big.md',
      content: '# Big\n' + Array.from({ length: 20 }, (_, i) => `Paragrafo ${i} ${'x'.repeat(300)}`).join('\n\n'),
      previewChars: 600,
      maxChunkChars: 1200,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1300)).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-chunker.test.ts
```

Expected: FAIL because `src/vault/semantic/chunker.ts` does not exist.

**Step 3: Implement minimal chunker and types**

Create `src/vault/semantic/types.ts`:

```ts
export interface SemanticChunk {
  path: string;
  chunk_index: number;
  heading: string;
  heading_path: string[];
  text: string;
  preview: string;
  content_hash: string;
}
```

Create `src/vault/semantic/chunker.ts`:

```ts
import crypto from 'node:crypto';
import matter from 'gray-matter';
import type { SemanticChunk } from './types.js';

interface ChunkInput {
  path: string;
  content: string;
  previewChars: number;
  maxChunkChars?: number;
}

export function chunkMarkdownSections(input: ChunkInput): SemanticChunk[] {
  const body = matter(input.content).content.trim();
  if (!body) return [];
  const maxChunkChars = input.maxChunkChars ?? 3500;
  const sections = splitSections(body);
  const chunks: SemanticChunk[] = [];

  for (const section of sections) {
    for (const text of splitLargeSection(section.text, maxChunkChars)) {
      const normalized = text.trim();
      if (!normalized) continue;
      chunks.push({
        path: input.path,
        chunk_index: chunks.length,
        heading: section.heading,
        heading_path: section.heading_path,
        text: normalized,
        preview: normalized.slice(0, input.previewChars),
        content_hash: crypto.createHash('sha256').update(normalized).digest('hex'),
      });
    }
  }

  return chunks;
}
```

Implement `splitSections()` and `splitLargeSection()` minimally to satisfy the tests.

**Step 4: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-chunker.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 5: Commit**

```bash
git add test/unit/semantic-chunker.test.ts src/vault/semantic
git commit -m "feat: chunk markdown for semantic memory"
```

---

### Task 4: Embedding Provider And Dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/vault/semantic/types.ts`
- Create: `test/unit/openai-embedding.test.ts`
- Create: `src/vault/semantic/openai-embedding.ts`

**Step 1: Write failing embedding tests**

Create `test/unit/openai-embedding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../src/vault/semantic/openai-embedding.js';

describe('OpenAIEmbeddingProvider', () => {
  it('requests embeddings with the configured model and dimensions', async () => {
    const calls: any[] = [];
    const client = {
      embeddings: {
        create: async (input: any) => {
          calls.push(input);
          return { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] };
        },
      },
    };
    const provider = new OpenAIEmbeddingProvider(client as any, {
      model: 'text-embedding-3-large',
      dimensions: 2,
    });

    const result = await provider.embedTexts(['a', 'b']);

    expect(calls[0]).toEqual({
      model: 'text-embedding-3-large',
      input: ['a', 'b'],
      dimensions: 2,
    });
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it('throws if OpenAI returns a different number of embeddings', async () => {
    const client = {
      embeddings: {
        create: async () => ({ data: [{ embedding: [0.1] }] }),
      },
    };
    const provider = new OpenAIEmbeddingProvider(client as any, {
      model: 'text-embedding-3-large',
      dimensions: 1,
    });

    await expect(provider.embedTexts(['a', 'b'])).rejects.toThrow(/embedding count/i);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/openai-embedding.test.ts
```

Expected: FAIL because `openai-embedding.ts` does not exist.

**Step 3: Install dependencies**

```bash
npm install openai pg
npm install -D @types/pg
```

Expected: `package.json` and `package-lock.json` update.

**Step 4: Implement minimal provider**

Extend `src/vault/semantic/types.ts`:

```ts
export interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
}
```

Create `src/vault/semantic/openai-embedding.ts`:

```ts
import OpenAI from 'openai';
import type { EmbeddingProvider } from './types.js';

interface OpenAIEmbeddingOptions {
  model: string;
  dimensions: number;
}

type OpenAIEmbeddingClient = Pick<OpenAI, 'embeddings'>;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly client: OpenAIEmbeddingClient, private readonly options: OpenAIEmbeddingOptions) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({
      model: this.options.model,
      input: texts,
      dimensions: this.options.dimensions,
    });
    const embeddings = response.data.map((item) => item.embedding);
    if (embeddings.length !== texts.length) {
      throw new Error(`OpenAI embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`);
    }
    return embeddings;
  }
}

export function createOpenAIEmbeddingProvider(apiKey: string, options: OpenAIEmbeddingOptions): OpenAIEmbeddingProvider {
  return new OpenAIEmbeddingProvider(new OpenAI({ apiKey }), options);
}
```

**Step 5: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/openai-embedding.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 6: Commit**

```bash
git add package.json package-lock.json test/unit/openai-embedding.test.ts src/vault/semantic
git commit -m "feat: add OpenAI semantic embedding provider"
```

---

### Task 5: Postgres Semantic Store

**Files:**
- Modify: `src/vault/semantic/types.ts`
- Create: `test/unit/postgres-semantic-store.test.ts`
- Create: `src/vault/semantic/postgres-store.ts`

**Step 1: Write failing store tests**

Create `test/unit/postgres-semantic-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PostgresSemanticStore, serializeVectorForSql } from '../../src/vault/semantic/postgres-store.js';

describe('PostgresSemanticStore', () => {
  it('serializes vectors for pgvector parameters', () => {
    expect(serializeVectorForSql([0.1, -0.2, 3])).toBe('[0.1,-0.2,3]');
  });

  it('creates pgvector extension and semantic tables', async () => {
    const queries: string[] = [];
    const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } };
    const store = new PostgresSemanticStore(pool as any, { dimensions: 3072 });

    await store.migrate();

    expect(queries.join('\n')).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(queries.join('\n')).toContain('CREATE TABLE IF NOT EXISTS semantic_chunks');
    expect(queries.join('\n')).toContain('embedding vector(3072)');
    expect(queries.join('\n')).toContain('CREATE TABLE IF NOT EXISTS semantic_index_state');
  });

  it('upserts chunks with preview metadata and vector casts', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const pool = { query: async (sql: string, params?: any[]) => { calls.push({ sql, params }); return { rows: [] }; } };
    const store = new PostgresSemanticStore(pool as any, { dimensions: 2 });

    await store.upsertChunks({
      path: '_journal/alfa/a.md',
      chunks: [{
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
      }],
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 2,
    });

    const combinedSql = calls.map((c) => c.sql).join('\n');
    expect(combinedSql).toContain('DELETE FROM semantic_chunks');
    expect(combinedSql).toContain('$8::vector');
    expect(calls.some((c) => c.params?.includes('[0.1,0.2]'))).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/postgres-semantic-store.test.ts
```

Expected: FAIL because `postgres-store.ts` does not exist.

**Step 3: Implement store types**

Extend `src/vault/semantic/types.ts`:

```ts
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
```

**Step 4: Implement minimal Postgres store**

Create `src/vault/semantic/postgres-store.ts` with:

- `serializeVectorForSql(vector: number[]): string`
- `PostgresSemanticStore.migrate()`
- `PostgresSemanticStore.upsertChunks()`
- `PostgresSemanticStore.deletePath()`
- `PostgresSemanticStore.search()`

Schema outline:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS semantic_chunks (
  chunk_id text PRIMARY KEY,
  path text NOT NULL,
  chunk_index integer NOT NULL,
  heading text NOT NULL,
  heading_path text[] NOT NULL,
  preview text NOT NULL,
  content_hash text NOT NULL,
  owner text,
  note_type text,
  tags text[] NOT NULL DEFAULT '{}',
  updated text,
  author_agent text,
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  embedding vector(3072) NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS semantic_chunks_path_model_idx
  ON semantic_chunks(path, chunk_index, embedding_model);

CREATE INDEX IF NOT EXISTS semantic_chunks_embedding_idx
  ON semantic_chunks USING ivfflat (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS semantic_index_state (
  path text PRIMARY KEY,
  content_hash text NOT NULL,
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  chunks_count integer NOT NULL,
  status text NOT NULL,
  error text,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
```

Use `vector(<dimensions>)` in generated SQL. Use `$8::vector` or the actual parameter index in inserts.

Search should compute a vector score:

```sql
1 - (embedding <=> $1::vector) AS vector_score
```

Then add a small lexical boost in SQL or TypeScript for query terms that appear in `preview`, `path`, `heading`, or `tags`. Clamp final score to `1.0`. Return only rows where final score is at least `minScore`.

**Step 5: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/postgres-semantic-store.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 6: Commit**

```bash
git add test/unit/postgres-semantic-store.test.ts src/vault/semantic
git commit -m "feat: add Postgres semantic store"
```

---

### Task 6: Semantic Indexing And Search Service

**Files:**
- Create: `test/unit/semantic-service.test.ts`
- Create: `src/vault/semantic/service.ts`
- Modify: `src/vault/semantic/types.ts`

**Step 1: Write failing service tests**

Create `test/unit/semantic-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';
import { SemanticMemoryService } from '../../src/vault/semantic/service.js';

async function makeVault(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-vault-'));
  fs.mkdirSync(path.join(root, '_shared/context'), { recursive: true });
  fs.writeFileSync(path.join(root, '_shared/context/AGENTS.md'), '```\n_journal/alfa/** => alfa\n_journal/beta/** => beta\n_entities/** => renato | alfa\n_runbooks/alfa-*.md => alfa\n```');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const index = new VaultIndex(root);
  await index.build();
  return { root, index };
}

describe('SemanticMemoryService', () => {
  it('indexes eligible notes with embeddings but stores only previews', async () => {
    const { root, index } = await makeVault({
      '_journal/alfa/2026-05-11-lead.md': `---
schema_version: 1
type: journal
status: active
author_agent: alfa
updated: 2026-05-11
tags: [lead]
---
# Atendimento
Cliente pediu valores completos.`,
    });
    const stored: any[] = [];
    const service = new SemanticMemoryService({
      vaultRoot: root,
      index,
      embeddings: { embedTexts: async (texts) => texts.map(() => [0.1, 0.2]) },
      store: {
        migrate: async () => {},
        upsertChunks: async (input) => stored.push(input),
        deletePath: async () => {},
        search: async () => [],
      },
      options: { embeddingModel: 'text-embedding-3-large', embeddingDimensions: 2, previewChars: 12, minScore: 0.75, maxResults: 5 },
    });

    await service.indexPath('_journal/alfa/2026-05-11-lead.md');

    expect(stored[0].chunks[0].preview).toBe('# Atendiment'.slice(0, 12));
    expect(stored[0].chunks[0]).not.toHaveProperty('text');
    expect(stored[0].chunks[0].metadata.author_agent).toBe('alfa');
  });

  it('rebuilds only own or authored notes for a non-admin agent', async () => {
    const { root, index } = await makeVault({
      '_journal/alfa/2026-05-11-a.md': '---\ntype: journal\nauthor_agent: alfa\n---\n# A',
      '_journal/beta/2026-05-11-b.md': '---\ntype: journal\nauthor_agent: beta\n---\n# B',
    });
    const paths: string[] = [];
    const service = new SemanticMemoryService({
      vaultRoot: root,
      index,
      embeddings: { embedTexts: async (texts) => texts.map(() => [0.1, 0.2]) },
      store: {
        migrate: async () => {},
        upsertChunks: async (input) => paths.push(input.path),
        deletePath: async () => {},
        search: async () => [],
      },
      options: { embeddingModel: 'text-embedding-3-large', embeddingDimensions: 2, previewChars: 600, minScore: 0.75, maxResults: 5 },
    });

    const result = await service.rebuild({ asAgent: 'alfa' });

    expect(paths).toEqual(['_journal/alfa/2026-05-11-a.md']);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('limits search results to min score and max results', async () => {
    const { root, index } = await makeVault({});
    const service = new SemanticMemoryService({
      vaultRoot: root,
      index,
      embeddings: { embedTexts: async () => [[0.1, 0.2]] },
      store: {
        migrate: async () => {},
        upsertChunks: async () => {},
        deletePath: async () => {},
        search: async () => [
          { path: 'a.md', chunk_id: 'a', chunk_index: 0, heading: 'A', heading_path: ['A'], preview: 'a', owner: 'alfa', type: 'journal', tags: [], score: 0.9, source: 'hybrid' },
          { path: 'b.md', chunk_id: 'b', chunk_index: 0, heading: 'B', heading_path: ['B'], preview: 'b', owner: 'alfa', type: 'journal', tags: [], score: 0.7, source: 'hybrid' },
        ],
      },
      options: { embeddingModel: 'text-embedding-3-large', embeddingDimensions: 2, previewChars: 600, minScore: 0.75, maxResults: 1 },
    });

    const results = await service.search({ query: 'cliente pediu valores' });

    expect(results.map((r) => r.path)).toEqual(['a.md']);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-service.test.ts
```

Expected: FAIL because `service.ts` does not exist.

**Step 3: Implement minimal service**

Create `src/vault/semantic/service.ts` with:

```ts
export class SemanticMemoryService {
  constructor(private readonly deps: SemanticMemoryDeps) {}

  async migrate(): Promise<void> {
    await this.deps.store.migrate();
  }

  async indexPath(rel: string): Promise<{ indexed: boolean; chunks: number }> {
    const entry = this.deps.index.get(rel);
    if (!entry || !entry.index_policy.vector) {
      await this.deps.store.deletePath(rel);
      return { indexed: false, chunks: 0 };
    }
    const content = await fsp.readFile(path.join(this.deps.vaultRoot, rel), 'utf8');
    const chunks = chunkMarkdownSections({ path: rel, content, previewChars: this.deps.options.previewChars });
    const embeddings = await this.deps.embeddings.embedTexts(chunks.map((c) => c.text));
    await this.deps.store.upsertChunks({
      path: rel,
      chunks: chunks.map((chunk, i) => ({
        ...withoutText(chunk),
        embedding: embeddings[i],
        metadata: metadataFromEntry(entry),
      })),
      embeddingModel: this.deps.options.embeddingModel,
      embeddingDimensions: this.deps.options.embeddingDimensions,
    });
    return { indexed: true, chunks: chunks.length };
  }

  async rebuild(input: { asAgent: string; path?: string; limit?: number; force?: boolean }): Promise<SemanticRebuildResult> {
    // Iterate VaultIndex entries, apply path filter, then own/authored filter unless asAgent === 'vault_admin'.
  }

  async search(input: SemanticSearchInput): Promise<SemanticSearchResult[]> {
    const [queryEmbedding] = await this.deps.embeddings.embedTexts([input.query]);
    const minScore = input.minScore ?? this.deps.options.minScore;
    const limit = Math.min(input.limit ?? this.deps.options.maxResults, this.deps.options.maxResults);
    const results = await this.deps.store.search({
      queryEmbedding,
      queryText: input.query,
      minScore,
      limit,
      filter: input.filter,
      embeddingModel: this.deps.options.embeddingModel,
    });
    return results.filter((r) => r.score >= minScore).slice(0, limit);
  }
}
```

Add exact types to `src/vault/semantic/types.ts`.

**Step 4: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-service.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 5: Commit**

```bash
git add test/unit/semantic-service.test.ts src/vault/semantic
git commit -m "feat: add semantic memory service"
```

---

### Task 7: Admin Rebuild And Explicit Semantic Search Tools

**Files:**
- Modify: `src/tools/_shared.ts`
- Modify: `src/tools/admin.ts`
- Create: `src/tools/semantic.ts`
- Modify: `src/server.ts`
- Create: `test/integration/semantic-tools.test.ts`

**Step 1: Write failing tool tests**

Create `test/integration/semantic-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rebuildSemanticIndex, semanticSearch } from '../../src/tools/semantic.js';

describe('semantic tools', () => {
  it('returns SEMANTIC_DISABLED when semantic service is not configured', async () => {
    const ctx: any = { semantic: undefined };

    const result = await semanticSearch({ query: 'cliente pediu valores' }, ctx);

    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe('SEMANTIC_DISABLED');
  });

  it('runs semantic_search through the semantic service', async () => {
    const calls: any[] = [];
    const ctx: any = {
      semantic: {
        search: async (input: any) => {
          calls.push(input);
          return [{ path: 'a.md', chunk_id: 'a', chunk_index: 0, heading: 'A', heading_path: ['A'], preview: 'preview', owner: 'alfa', type: 'journal', tags: [], score: 0.9, source: 'hybrid' }];
        },
      },
    };

    const result = await semanticSearch({ query: 'cliente pediu valores', owner: 'alfa', limit: 5 }, ctx);

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ query: 'cliente pediu valores', limit: 5 });
    expect((result.structuredContent as any).matches).toHaveLength(1);
  });

  it('runs rebuild_semantic_index with as_agent scope', async () => {
    const calls: any[] = [];
    const ctx: any = {
      semantic: {
        rebuild: async (input: any) => {
          calls.push(input);
          return { indexed: 2, skipped: 1, deleted: 0, errors: [] };
        },
      },
    };

    const result = await rebuildSemanticIndex({ as_agent: 'alfa', path: '_journal/alfa', limit: 10 }, ctx);

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ asAgent: 'alfa', path: '_journal/alfa', limit: 10 });
    expect((result.structuredContent as any).indexed).toBe(2);
  });
});
```

Add a server registry test if one exists for tool count; otherwise add a small unit test for `createMcpServer().setRequestHandler` only if practical.

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/integration/semantic-tools.test.ts
```

Expected: FAIL because `src/tools/semantic.ts` does not exist.

**Step 3: Extend shared context**

Modify `src/tools/_shared.ts`:

```ts
import type { SemanticMemoryService } from '../vault/semantic/service.js';

export interface ToolCtx {
  index: VaultIndex;
  vaultRoot: string;
  git?: GitOps;
  queue?: CommitQueue;
  lock?: ResolutionLock;
  semantic?: SemanticMemoryService;
}
```

**Step 4: Implement semantic tools**

Create `src/tools/semantic.ts`:

```ts
import { z } from 'zod';
import { McpError, McpToolResponse } from '../errors.js';
import { ok, ToolCtx, tryToolBody } from './_shared.js';

export const SemanticSearchSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  type: z.string().optional(),
  tag: z.string().optional(),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  min_score: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().max(20).optional().default(5),
});

export const RebuildSemanticIndexSchema = z.object({
  as_agent: z.string().min(1),
  path: z.string().optional(),
  force: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(5000).optional(),
});
```

Implement:

- `semanticSearch(args, ctx)`
- `rebuildSemanticIndex(args, ctx)`

If `ctx.semantic` is missing, return `new McpError('SEMANTIC_DISABLED', 'Semantic memory is disabled. Set SEMANTIC_ENABLED=true and configure Postgres/OpenAI.')`.

**Step 5: Register tools**

Modify `src/server.ts`:

```ts
import * as semantic from './tools/semantic.js';
```

Add registry entries:

```ts
semantic_search: { schema: semantic.SemanticSearchSchema, handler: semantic.semanticSearch, desc: 'Semantic memory search over indexed vault chunks', annotations: { readOnlyHint: true, openWorldHint: false } },
rebuild_semantic_index: { schema: semantic.RebuildSemanticIndexSchema, handler: semantic.rebuildSemanticIndex, desc: 'Rebuild semantic memory index for own/authored scope or vault_admin global scope', annotations: { openWorldHint: false } },
```

Expected public surface becomes **47 tools + 2 resources**.

**Step 6: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/integration/semantic-tools.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 7: Commit**

```bash
git add src/tools/_shared.ts src/tools/semantic.ts src/server.ts test/integration/semantic-tools.test.ts
git commit -m "feat: expose semantic memory tools"
```

---

### Task 8: Create Semantic Service At Server Startup

**Files:**
- Modify: `src/server.ts`
- Create: `test/unit/semantic-factory.test.ts`
- Create: `src/vault/semantic/factory.ts`

**Step 1: Write failing factory tests**

Create `test/unit/semantic-factory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSemanticMemoryFromConfig } from '../../src/vault/semantic/factory.js';

describe('createSemanticMemoryFromConfig', () => {
  it('returns undefined when semantic memory is disabled', async () => {
    const service = await createSemanticMemoryFromConfig({
      semantic: { enabled: false },
    } as any, {} as any);

    expect(service).toBeUndefined();
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
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-factory.test.ts
```

Expected: FAIL because `factory.ts` does not exist.

**Step 3: Implement semantic factory**

Create `src/vault/semantic/factory.ts`:

```ts
import pg from 'pg';
import { SemanticMemoryService } from './service.js';
import { PostgresSemanticStore } from './postgres-store.js';
import { createOpenAIEmbeddingProvider } from './openai-embedding.js';

export async function createSemanticMemoryFromConfig(config: any, deps: SemanticFactoryDeps) {
  if (!config.semantic.enabled) return undefined;
  const pool = deps.makePool ? deps.makePool(config.semantic.databaseUrl) : new pg.Pool({ connectionString: config.semantic.databaseUrl });
  const embeddings = deps.makeEmbeddingProvider
    ? deps.makeEmbeddingProvider(config.semantic)
    : createOpenAIEmbeddingProvider(config.semantic.openaiApiKey, {
        model: config.semantic.embeddingModel,
        dimensions: config.semantic.embeddingDimensions,
      });
  const store = new PostgresSemanticStore(pool, { dimensions: config.semantic.embeddingDimensions });
  const service = new SemanticMemoryService({
    vaultRoot: deps.vaultRoot,
    index: deps.index,
    embeddings,
    store,
    options: config.semantic,
  });
  await service.migrate();
  deps.onMigrate?.();
  return service;
}
```

Use stricter exported types instead of `any` in final code.

**Step 4: Wire into `initCtx`**

Modify `src/server.ts`:

```ts
const semantic = await createSemanticMemoryFromConfig(config, {
  vaultRoot: config.vaultPath,
  index,
});
```

Return it in context:

```ts
return { index, vaultRoot: config.vaultPath, git, queue, lock, worker, semantic };
```

Log whether semantic memory is enabled or disabled.

**Step 5: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-factory.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 6: Commit**

```bash
git add src/vault/semantic/factory.ts src/server.ts test/unit/semantic-factory.test.ts
git commit -m "feat: initialize semantic memory service"
```

---

### Task 9: Automatic Semantic Memory And Write Warnings

**Files:**
- Create: `test/unit/semantic-augment.test.ts`
- Create: `src/tools/semantic-augment.ts`
- Modify: `src/server.ts`

**Step 1: Write failing augmentation tests**

Create `test/unit/semantic-augment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ok } from '../../src/tools/_shared.js';
import { augmentSemanticResponse } from '../../src/tools/semantic-augment.js';

const memoryHit = {
  path: '_journal/alfa/2026-05-11-lead.md',
  chunk_id: 'hit-1',
  chunk_index: 0,
  heading: 'Atendimento',
  heading_path: ['Atendimento'],
  preview: 'Cliente pediu valores.',
  owner: 'alfa',
  type: 'journal',
  tags: ['lead'],
  score: 0.91,
  source: 'hybrid' as const,
};

describe('augmentSemanticResponse', () => {
  it('adds semantic_memory to successful read responses', async () => {
    const ctx: any = {
      semantic: {
        search: async (input: any) => {
          expect(input.query).toContain('Cliente atual');
          expect(input.filter.excludePath).toBe('_journal/alfa/current.md');
          return [memoryHit];
        },
      },
    };
    const response = ok({
      path: '_journal/alfa/current.md',
      content: '# Cliente atual\nPrecisa de financiamento.',
    }, 'Read current');

    const augmented = await augmentSemanticResponse('read_note', { path: '_journal/alfa/current.md' }, response, ctx, { readOnlyHint: true });

    expect((augmented.structuredContent as any).semantic_memory).toEqual([memoryHit]);
  });

  it('adds semantic_warnings to successful write responses', async () => {
    const ctx: any = {
      semantic: {
        search: async () => [memoryHit],
      },
    };
    const response = ok({ path: '_journal/alfa/new.md', created: true }, 'Created');

    const augmented = await augmentSemanticResponse('create_journal_event', {
      title: 'Atendimento',
      content: 'Cliente pediu valores.',
    }, response, ctx, { openWorldHint: false });

    expect((augmented.structuredContent as any).semantic_warnings).toEqual([memoryHit]);
  });

  it('does not fail the original tool when semantic search fails', async () => {
    const ctx: any = {
      semantic: {
        search: async () => { throw new Error('postgres down'); },
      },
    };
    const response = ok({ path: 'x.md' }, 'ok');

    const augmented = await augmentSemanticResponse('search_content', { query: 'x' }, response, ctx, { readOnlyHint: true });

    expect(augmented).toBe(response);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-augment.test.ts
```

Expected: FAIL because `semantic-augment.ts` does not exist.

**Step 3: Implement augmentation helper**

Create `src/tools/semantic-augment.ts`:

```ts
import { McpToolResponse } from '../errors.js';
import type { ToolCtx } from './_shared.js';

export async function augmentSemanticResponse(
  toolName: string,
  args: unknown,
  response: McpToolResponse,
  ctx: ToolCtx,
  annotations: Record<string, boolean>,
): Promise<McpToolResponse> {
  if (!ctx.semantic || response.isError) return response;
  const query = buildSemanticQuery(toolName, args, response);
  if (!query) return response;
  try {
    const matches = await ctx.semantic.search({
      query,
      limit: 5,
      filter: extractSemanticFilter(args, response),
    });
    if (matches.length === 0) return response;
    const key = annotations.readOnlyHint ? 'semantic_memory' : 'semantic_warnings';
    return {
      ...response,
      structuredContent: {
        ...(response.structuredContent as Record<string, unknown>),
        [key]: matches,
      },
    };
  } catch {
    return response;
  }
}
```

Implement:

- `buildSemanticQuery()` from `args.query`, `args.content`, `args.title`, `structuredContent.content`, `structuredContent.path`, and small metadata fields.
- `extractSemanticFilter()` with `excludePath` for current read path and `path`/`owner`/`type`/`tag` when available.
- Hard cap automatic augmentation at 5 results.

**Step 4: Wire augmentation into server**

Modify `src/server.ts`:

```ts
const response = await entry.handler(req.params.arguments, ctx);
return await augmentSemanticResponse(req.params.name, req.params.arguments, response, ctx, entry.annotations);
```

Do this after the handler so semantic failures never block normal tool behavior.

**Step 5: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-augment.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 6: Commit**

```bash
git add test/unit/semantic-augment.test.ts src/tools/semantic-augment.ts src/server.ts
git commit -m "feat: augment tool responses with semantic memory"
```

---

### Task 10: Non-Blocking Incremental Semantic Index Updates

**Files:**
- Modify: `test/unit/semantic-augment.test.ts`
- Modify: `src/tools/semantic-augment.ts`
- Modify: `src/server.ts`

**Step 1: Write failing side-effect tests**

Add to `test/unit/semantic-augment.test.ts`:

```ts
import { applySemanticSideEffects } from '../../src/tools/semantic-augment.js';

it('indexes written paths after successful write responses', async () => {
  const indexed: string[] = [];
  const ctx: any = {
    semantic: {
      indexPath: async (path: string) => indexed.push(path),
    },
  };
  const response = ok({ path: '_journal/alfa/new.md', created: true }, 'Created');

  await applySemanticSideEffects('write_note', { path: '_journal/alfa/new.md' }, response, ctx);

  expect(indexed).toEqual(['_journal/alfa/new.md']);
});

it('deletes semantic chunks after successful delete responses', async () => {
  const deleted: string[] = [];
  const ctx: any = {
    semantic: {
      deletePath: async (path: string) => deleted.push(path),
    },
  };
  const response = ok({ path: '_journal/alfa/old.md', deleted: true }, 'Deleted');

  await applySemanticSideEffects('delete_note', { path: '_journal/alfa/old.md' }, response, ctx);

  expect(deleted).toEqual(['_journal/alfa/old.md']);
});

it('does not fail the original tool when semantic indexing fails', async () => {
  const ctx: any = {
    semantic: {
      indexPath: async () => { throw new Error('postgres down'); },
    },
  };
  const response = ok({ path: 'x.md' }, 'ok');

  await expect(applySemanticSideEffects('write_note', { path: 'x.md' }, response, ctx)).resolves.toBeUndefined();
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-augment.test.ts
```

Expected: FAIL because `applySemanticSideEffects` does not exist.

**Step 3: Implement side effects**

In `src/tools/semantic-augment.ts`, export:

```ts
export async function applySemanticSideEffects(
  toolName: string,
  args: unknown,
  response: McpToolResponse,
  ctx: ToolCtx,
): Promise<void> {
  if (!ctx.semantic || response.isError) return;
  try {
    if (toolName === 'delete_note' || toolName === 'delete_path') {
      for (const rel of extractWrittenPaths(args, response)) await ctx.semantic.deletePath(rel);
      return;
    }
    if (isWriteTool(toolName)) {
      for (const rel of extractWrittenPaths(args, response)) await ctx.semantic.indexPath(rel);
    }
  } catch {
    return;
  }
}
```

Update `SemanticMemoryService` with:

```ts
async deletePath(rel: string): Promise<void> {
  await this.deps.store.deletePath(rel);
}
```

**Step 4: Wire side effects into server**

Modify `src/server.ts`:

```ts
const response = await entry.handler(req.params.arguments, ctx);
await applySemanticSideEffects(req.params.name, req.params.arguments, response, ctx);
return await augmentSemanticResponse(req.params.name, req.params.arguments, response, ctx, entry.annotations);
```

Side effects should run before warnings so a successful write can update the index. The warning query may still find similar existing context; if the new path appears, use `excludePath` to suppress self-hits.

**Step 5: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-augment.test.ts test/unit/semantic-service.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 6: Commit**

```bash
git add test/unit/semantic-augment.test.ts src/tools/semantic-augment.ts src/vault/semantic/service.ts src/server.ts
git commit -m "feat: update semantic index after vault writes"
```

---

### Task 11: Docker Compose, Env Example, And README

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Step 1: Write failing documentation/config expectations**

Add a lightweight config/docs test only if there is an existing docs-test pattern. If not, use a manual verification step for this documentation-only task.

Manual checks before editing:

```bash
grep -n "SEMANTIC_ENABLED" .env.example README.md docker-compose.yml
```

Expected: no matches before this task.

**Step 2: Update `.env.example`**

Add:

```dotenv
# Semantic memory (optional)
SEMANTIC_ENABLED=false
SEMANTIC_DATABASE_URL=postgresql://mcp_obsidian:replace-me@semantic-postgres:5432/mcp_obsidian
OPENAI_API_KEY=
SEMANTIC_EMBEDDING_MODEL=text-embedding-3-large
SEMANTIC_EMBEDDING_DIMENSIONS=3072
SEMANTIC_MIN_SCORE=0.75
SEMANTIC_MAX_RESULTS=5
SEMANTIC_PREVIEW_CHARS=600
```

**Step 3: Update `docker-compose.yml`**

Add a dedicated pgvector service:

```yaml
  semantic-postgres:
    image: pgvector/pgvector:pg16
    networks:
      - network_public
    environment:
      - POSTGRES_DB=mcp_obsidian
      - POSTGRES_USER=mcp_obsidian
      - POSTGRES_PASSWORD=${SEMANTIC_POSTGRES_PASSWORD:-replace-me}
    volumes:
      - semantic_postgres_data:/var/lib/postgresql/data
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
```

Add to `mcp-obsidian` env:

```yaml
      - SEMANTIC_ENABLED=${SEMANTIC_ENABLED:-false}
      - SEMANTIC_DATABASE_URL=${SEMANTIC_DATABASE_URL:-postgresql://mcp_obsidian:replace-me@semantic-postgres:5432/mcp_obsidian}
      - SEMANTIC_EMBEDDING_MODEL=${SEMANTIC_EMBEDDING_MODEL:-text-embedding-3-large}
      - SEMANTIC_EMBEDDING_DIMENSIONS=${SEMANTIC_EMBEDDING_DIMENSIONS:-3072}
      - SEMANTIC_MIN_SCORE=${SEMANTIC_MIN_SCORE:-0.75}
      - SEMANTIC_MAX_RESULTS=${SEMANTIC_MAX_RESULTS:-5}
      - SEMANTIC_PREVIEW_CHARS=${SEMANTIC_PREVIEW_CHARS:-600}
```

Add volume:

```yaml
volumes:
  semantic_postgres_data:
```

Keep `OPENAI_API_KEY` in `.env`, not hardcoded in compose.

**Step 4: Update `README.md`**

Update:

- Current public surface: `47 tools + 2 resources`
- Quickstart expected tool count: `47`
- Runtime env var table with semantic variables
- Tools section with:
  - `semantic_search`
  - `rebuild_semantic_index`
- Add short "Semantic Memory" section:
  - disabled by default
  - uses dedicated Postgres/pgvector
  - uses OpenAI `text-embedding-3-large`
  - stores metadata, embeddings, and previews only
  - automatic `semantic_memory` for reads and `semantic_warnings` for writes
  - first rebuild command should be `rebuild_semantic_index` with `as_agent: "vault_admin"`

**Step 5: Verify docs contain expected strings**

```bash
grep -n "SEMANTIC_ENABLED" .env.example README.md docker-compose.yml
grep -n "semantic_search" README.md
grep -n "rebuild_semantic_index" README.md
```

Expected: all commands find matches.

**Step 6: Run typecheck and tests**

```bash
npm run typecheck
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test
```

Expected: typecheck exits `0`; all tests pass.

**Step 7: Commit**

```bash
git add .env.example docker-compose.yml README.md
git commit -m "docs: document semantic memory runtime"
```

---

### Task 12: Evaluation Harness For Semantic Search Quality

**Files:**
- Create: `test/unit/semantic-eval.test.ts`
- Create: `src/vault/semantic/eval.ts`
- Create: `scripts/eval-semantic-memory.ts`
- Modify: `README.md`

**Step 1: Write failing metric tests**

Create `test/unit/semantic-eval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateSemanticResults } from '../../src/vault/semantic/eval.js';

describe('evaluateSemanticResults', () => {
  it('computes hit rate and mean reciprocal rank', () => {
    const result = evaluateSemanticResults([
      { query: 'cliente pediu valores', expectedPaths: ['_journal/alfa/a.md'], actualPaths: ['_journal/alfa/a.md', '_journal/alfa/b.md'] },
      { query: 'runbook de repasse', expectedPaths: ['_runbooks/alfa-repasse.md'], actualPaths: ['_journal/alfa/a.md', '_runbooks/alfa-repasse.md'] },
      { query: 'nao encontrado', expectedPaths: ['missing.md'], actualPaths: [] },
    ]);

    expect(result.hitRateAt5).toBeCloseTo(2 / 3);
    expect(result.meanReciprocalRank).toBeCloseTo((1 + 0.5 + 0) / 3);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-eval.test.ts
```

Expected: FAIL because `eval.ts` does not exist.

**Step 3: Implement metrics**

Create `src/vault/semantic/eval.ts`:

```ts
export interface SemanticEvalCase {
  query: string;
  expectedPaths: string[];
  actualPaths: string[];
}

export function evaluateSemanticResults(cases: SemanticEvalCase[]) {
  if (cases.length === 0) return { cases: 0, hitRateAt5: 0, meanReciprocalRank: 0 };
  let hits = 0;
  let reciprocalRankSum = 0;
  for (const c of cases) {
    const expected = new Set(c.expectedPaths);
    const rank = c.actualPaths.slice(0, 5).findIndex((path) => expected.has(path));
    if (rank >= 0) {
      hits += 1;
      reciprocalRankSum += 1 / (rank + 1);
    }
  }
  return {
    cases: cases.length,
    hitRateAt5: hits / cases.length,
    meanReciprocalRank: reciprocalRankSum / cases.length,
  };
}
```

**Step 4: Create optional live eval script**

Create `scripts/eval-semantic-memory.ts`:

- Load `.env`
- Require `SEMANTIC_ENABLED=true`
- Require `API_KEY` and local MCP endpoint URL or use direct service creation if simpler
- Run a small list of curated queries against `semantic_search`
- Print `hitRateAt5` and `meanReciprocalRank`
- Exit non-zero only if explicit `SEMANTIC_EVAL_STRICT=true` and metrics are below thresholds

Example cases to include as placeholders:

```ts
const cases = [
  {
    query: 'lead pediu tabela de valores e financiamento',
    expectedPaths: ['_journal/alfa/2026-05-11-atendimento.md'],
  },
  {
    query: 'procedimento operacional para corretor sem resposta',
    expectedPaths: ['_runbooks/alfa-vault-operacao.md'],
  },
];
```

**Step 5: Document eval**

Add to README:

```bash
SEMANTIC_ENABLED=true npm run eval:semantic
```

Add script to `package.json`:

```json
"eval:semantic": "tsx scripts/eval-semantic-memory.ts"
```

**Step 6: Run tests to verify they pass**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test -- test/unit/semantic-eval.test.ts
npm run typecheck
```

Expected: PASS and typecheck exits `0`.

**Step 7: Commit**

```bash
git add test/unit/semantic-eval.test.ts src/vault/semantic/eval.ts scripts/eval-semantic-memory.ts package.json README.md
git commit -m "feat: add semantic memory evaluation harness"
```

---

### Task 13: Full Verification

**Files:**
- No new files unless fixing failures found by verification.

**Step 1: Run full tests**

```bash
API_KEY=t VAULT_PATH=/tmp/mcp-obsidian-baseline npm test
```

Expected: all test files pass. Tool count tests or README expectations should reflect `47`.

**Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: exits `0`.

**Step 3: Run build**

```bash
npm run build
```

Expected: exits `0` and produces `dist/`.

**Step 4: Inspect git status**

```bash
git status --short
```

Expected: clean after commits, or only intentional generated artifacts ignored by `.gitignore`.

**Step 5: Final commit only if verification required fixes**

```bash
git add <fixed-files>
git commit -m "fix: finalize semantic memory verification"
```

Expected: commit created only if there were changes after Task 12.

---

## Rollout Notes

1. Deploy with `SEMANTIC_ENABLED=false` first. The release should behave like the current server except for the additional tools returning `SEMANTIC_DISABLED`.
2. Start the dedicated Postgres/pgvector service and set `SEMANTIC_DATABASE_URL`.
3. Add `OPENAI_API_KEY` in the server `.env`.
4. Enable `SEMANTIC_ENABLED=true`.
5. Run `rebuild_semantic_index` as `vault_admin` for the first full build.
6. Run the semantic eval script and inspect examples manually before treating automatic memory as reliable.

## Deferred Work

- Background worker for periodic rebuilds and stale chunk cleanup beyond write-triggered updates.
- Read ACLs for sensitive or private notes.
- Multi-model/index versioning if the embedding model changes.
- Richer hybrid search using full-vault lexical candidates from `ripgrep`; the first release uses vector search plus metadata/preview lexical boosts.
- Cost telemetry for embedding requests.
