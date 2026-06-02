import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/server.js';
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

  it('registers semantic tools in tools/list', async () => {
    const server = createMcpServer();
    const listTools = (server as any)._requestHandlers.get('tools/list');

    const result = await listTools({ method: 'tools/list', params: {} });
    const names = result.tools.map((tool: any) => tool.name);

    expect(result.tools).toHaveLength(47);
    expect(names).toEqual(expect.arrayContaining(['semantic_search', 'rebuild_semantic_index']));
  });
});
