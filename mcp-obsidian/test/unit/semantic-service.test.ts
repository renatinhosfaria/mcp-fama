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

  it('deletes stale chunks when a path is missing or not vector eligible', async () => {
    const { root, index } = await makeVault({
      '_journal/alfa/draft.md': '---\ntype: journal\nstatus: draft\nauthor_agent: alfa\n---\n# Draft',
    });
    const deleted: string[] = [];
    const service = new SemanticMemoryService({
      vaultRoot: root,
      index,
      embeddings: { embedTexts: async (texts) => texts.map(() => [0.1, 0.2]) },
      store: {
        migrate: async () => {},
        upsertChunks: async () => {},
        deletePath: async (rel) => { deleted.push(rel); },
        search: async () => [],
      },
      options: { embeddingModel: 'text-embedding-3-large', embeddingDimensions: 2, previewChars: 600, minScore: 0.75, maxResults: 5 },
    });

    await expect(service.indexPath('_journal/alfa/missing.md')).resolves.toEqual({ indexed: false, chunks: 0 });
    await expect(service.indexPath('_journal/alfa/draft.md')).resolves.toEqual({ indexed: false, chunks: 0 });
    expect(deleted).toEqual(['_journal/alfa/missing.md', '_journal/alfa/draft.md']);
  });

  it('rebuilds only own or authored notes for a non-admin agent', async () => {
    const { root, index } = await makeVault({
      '_journal/alfa/2026-05-11-a.md': '---\ntype: journal\nauthor_agent: alfa\n---\n# A',
      '_journal/beta/2026-05-11-b.md': '---\ntype: journal\nauthor_agent: beta\n---\n# B',
      '_journal/beta/2026-05-11-authored-by-alfa.md': '---\ntype: journal\nauthor_agent: alfa\n---\n# Authored',
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

    expect(paths).toEqual(['_journal/alfa/2026-05-11-a.md', '_journal/beta/2026-05-11-authored-by-alfa.md']);
    expect(result.indexed).toBe(2);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('rebuilds globally for vault admin', async () => {
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

    const result = await service.rebuild({ asAgent: 'vault_admin' });

    expect(paths.sort()).toEqual(['_journal/alfa/2026-05-11-a.md', '_journal/beta/2026-05-11-b.md']);
    expect(result.indexed).toBe(2);
    expect(result.skipped).toBe(1);
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

  it('passes search options through to the store', async () => {
    const { root, index } = await makeVault({});
    const searches: any[] = [];
    const service = new SemanticMemoryService({
      vaultRoot: root,
      index,
      embeddings: { embedTexts: async (texts) => texts.map(() => [0.3, 0.4]) },
      store: {
        migrate: async () => {},
        upsertChunks: async () => {},
        deletePath: async () => {},
        search: async (input) => {
          searches.push(input);
          return [];
        },
      },
      options: { embeddingModel: 'text-embedding-3-large', embeddingDimensions: 2, previewChars: 600, minScore: 0.75, maxResults: 5 },
    });

    await service.search({ query: 'cliente pediu valores', minScore: 0.82, limit: 2, filter: { owner: 'alfa', type: 'journal' } });

    expect(searches[0]).toMatchObject({
      queryEmbedding: [0.3, 0.4],
      queryText: 'cliente pediu valores',
      minScore: 0.82,
      limit: 2,
      filter: { owner: 'alfa', type: 'journal' },
      embeddingModel: 'text-embedding-3-large',
    });
  });
});
