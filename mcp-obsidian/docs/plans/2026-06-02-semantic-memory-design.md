# MCP Obsidian Semantic Memory Design

Date: 2026-06-02

## Goal

Evolve `mcp-obsidian` from exact text search into automatic semantic memory for
agents. The vault remains the source of truth. Semantic search is an auxiliary,
rebuildable index that helps tools return relevant context and warnings without
blocking normal vault operations.

## Decisions

- Embedding model: `text-embedding-3-large`.
- Vector dimensions: `3072`.
- Storage: a dedicated internal Postgres service with pgvector.
- Initial indexed folders: `_entities`, `_hubs`, `_decisions`, `_runbooks`,
  and `_journal`.
- Chunking: Markdown sections, with useful frontmatter prefixed into each
  chunk before embedding.
- Automatic behavior: always enabled for semantic-eligible tools.
- Read tools return `semantic_memory`.
- Write tools return `semantic_warnings`.
- Results per call: maximum 5 memories or warnings.
- Write blocking: none in v1. Warnings are advisory only.
- Minimum raw semantic similarity: `0.75`.
- Ranking: hybrid ranking after the similarity threshold.
- Stored text: preview only, maximum 600 characters. Full content stays in the
  vault.
- Initial indexing: explicit admin tool `rebuild_semantic_index`.
- Later indexing: background `SemanticWorker`.
- Evaluation: stable repo fixtures plus live vault eval notes.

## Architecture

Add a `SemanticIndex` layer to `mcp-obsidian` without replacing `VaultIndex`.
`VaultIndex` continues to parse Markdown, frontmatter, ownership, tags,
wikilinks, backlinks, mtime, and `index_policy`. `SemanticIndex` stores
chunk-level metadata and embeddings in a dedicated Postgres database with
pgvector.

Deployment adds a private `mcp-obsidian-postgres` service on the same Docker
network as `mcp-obsidian`. The database is not exposed externally. The MCP
container connects through an internal URL such as:

```text
postgres://...@mcp-obsidian-postgres:5432/obsidian_semantic
```

The semantic database is not a system of record. If it is deleted or becomes
stale, it can be rebuilt from the Markdown vault.

## Postgres Schema

Use one primary table for chunks:

```sql
CREATE TABLE semantic_note_chunks (
  id bigserial PRIMARY KEY,
  vault_id text NOT NULL DEFAULT 'default',
  path text NOT NULL,
  chunk_id text NOT NULL,
  chunk_hash text NOT NULL,
  embedding vector(3072) NOT NULL,
  preview text NOT NULL,
  type text,
  owner text,
  author_agent text,
  source text,
  trust_level text,
  status text,
  tags text[] NOT NULL DEFAULT '{}',
  wikilinks text[] NOT NULL DEFAULT '{}',
  mtime timestamptz,
  updated text,
  created_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, path, chunk_id)
);
```

Indexes:

```sql
CREATE INDEX semantic_note_chunks_embedding_hnsw
  ON semantic_note_chunks
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX semantic_note_chunks_path_idx
  ON semantic_note_chunks (vault_id, path);

CREATE INDEX semantic_note_chunks_filters_idx
  ON semantic_note_chunks (vault_id, owner, type, status, trust_level);
```

The table stores only metadata, embeddings, and a short preview. It does not
store full chunk content.

## Indexing Flow

`rebuild_semantic_index` performs initial indexing. It scans vault entries,
applies scope and ownership rules, respects `index_policy`, chunks each note by
Markdown headings, generates embeddings with `text-embedding-3-large`, and
upserts chunk rows in Postgres.

For each note:

1. Load the note from the vault.
2. Parse frontmatter and body.
3. Skip notes outside semantic scope.
4. Skip notes where `index_policy.vector` is false unless an explicit allowed
   override is added later.
5. Split by Markdown sections.
6. Prefix each chunk with selected frontmatter fields: type, title/name, owner,
   author_agent, tags, source, status, related links, and key entity fields.
7. Hash the effective embedding input.
8. Generate embedding only when hash changed.
9. Store embedding, metadata, path, chunk id, hash, and preview.

Deleted notes remove all rows for their path.

## Rebuild Permissions

`rebuild_semantic_index` is scoped.

- `vault_admin` can rebuild the entire semantic index.
- A normal agent can rebuild only notes they own or authored.
- Optional filters include `path_prefix`, `types`, `limit`, and `cursor`.
- Each candidate note is checked individually before indexing.

The tool should return counts and errors:

```json
{
  "notes_scanned": 1200,
  "notes_indexed": 740,
  "chunks_indexed": 3100,
  "skipped": {
    "ownership": 10,
    "index_policy": 430,
    "invalid_frontmatter": 8
  },
  "errors": []
}
```

## Automatic Memory Augmentation

Add a `MemoryAugmentor` wrapper around MCP tool handlers. It builds a semantic
query from the tool name and arguments. Tools with no meaningful query, such as
low-level status checks, may return no semantic memory rather than forcing a
noisy search. Examples:

- `create_journal_event`: title, content, participants, related entities.
- `record_decision`: title, rationale, mentioned entities, related links.
- `create_or_update_entity`: name, entity type, aliases, external ids, content.
- `read_lead_history`: agent and lead name.
- `get_broker_operational_summary`: agent and broker name.
- `read_agent_context`: agent and requested context shape.

Read tools append:

```json
{
  "semantic_memory": [
    {
      "path": "_entities/cliente-x.md",
      "type": "entity",
      "score": 0.84,
      "reason": "semantic match",
      "preview": "..."
    }
  ]
}
```

Write tools append:

```json
{
  "semantic_warnings": [
    {
      "kind": "possible_duplicate",
      "path": "_entities/cliente-x.md",
      "score": 0.91,
      "message": "Similar entity already exists.",
      "preview": "..."
    }
  ]
}
```

Warnings never block the write in v1.

## Ranking

Search first filters by raw vector similarity:

```text
similarity >= 0.75
```

Then results are reranked with a hybrid score:

```text
final_score =
  semantic_similarity
  + type_bonus
  + trust_bonus
  + recency_bonus
  + backlink_bonus
```

Initial bonus guidance:

```text
_decisions  +0.08
_entities   +0.07
_runbooks   +0.06
_hubs       +0.04
_journal    +0.00

human_curated     +0.08
human_verified    +0.06
agent_verified    +0.03
unverified_agent  +0.00
```

`_journal` is indexed from the start but should not outrank consolidated
knowledge merely because it is textually close. Recency and high similarity can
still lift journal entries when they are relevant.

## Failure Handling

Semantic memory must be non-critical in v1.

- If Postgres is down, tool behavior continues.
- If the embedding provider fails, tool behavior continues.
- If semantic ranking fails, tool behavior continues.
- The response includes a compact `semantic_status` warning when augmentation
  was attempted but unavailable.
- Rebuild errors are reported per path without aborting the entire run unless
  the database connection or provider configuration is invalid.

This keeps the vault reliable even while semantic search is experimental.

## Configuration

New environment variables:

```text
SEMANTIC_SEARCH_ENABLED=true
SEMANTIC_DATABASE_URL=postgres://...
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-large
SEMANTIC_TOP_K=5
SEMANTIC_MIN_SIMILARITY=0.75
SEMANTIC_PREVIEW_CHARS=600
SEMANTIC_INDEX_JOURNAL=true
```

The OpenAI API key should be read from an environment variable or file-based
secret. It must never be returned in MCP responses, logs, examples, or commits.

## Evaluation

Keep stable eval fixtures in the repo:

```text
mcp-obsidian/test/fixtures/semantic-eval/*.json
```

Keep live eval notes in the vault:

```text
_shared/context/semantic-eval/*.md
```

Each case should define a query, expected paths, and optional paths that must
not appear. Metrics:

- `recall@5`
- `precision@5`
- `mrr`

Initial acceptance target:

```text
recall@5 >= 0.70
```

The target can be raised after real use shows stable behavior.

## Implementation Phases

1. Add Postgres/pgvector service and semantic configuration.
2. Add schema migration for `semantic_note_chunks`.
3. Implement `EmbeddingProvider` with OpenAI `text-embedding-3-large`.
4. Implement Markdown section chunking and preview generation.
5. Implement `SemanticIndex` upsert, delete, and search.
6. Add `rebuild_semantic_index` with scoped permissions.
7. Add explicit `semantic_search` for debugging and evaluation.
8. Add `MemoryAugmentor` to semantic-eligible read and write tools.
9. Add semantic eval fixtures and tests.
10. Add `SemanticWorker` for incremental background updates.

## Open Questions

- Whether `index_policy.vector` should be changed so `_journal` has vector
  indexing enabled, or whether semantic indexing should have a separate policy.
- Which low-signal tools should explicitly opt out if automatic memory creates
  noise or unnecessary cost.
- Whether write warnings should include conflict categories beyond duplicate,
  related decision, related runbook, and similar entity.
- Whether live eval notes in the vault should be read by a tool or imported
  manually into test fixtures.
