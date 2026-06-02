import { describe, expect, it } from 'vitest';
import { rebuildSemanticIndex, semanticSearch } from '../../src/tools/semantic.js';

describe('semantic tools', () => {
  it('returns SEMANTIC_DISABLED when semantic service is not configured', async () => {
    const ctx: any = { semantic: undefined };

    const result = await semanticSearch({ query: 'cliente pediu valores' }, ctx);

    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe('SEMANTIC_DISABLED');
  });

  it('returns SEMANTIC_DISABLED before validating semantic_search args', async () => {
    const result = await semanticSearch({}, { semantic: undefined } as any);

    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe('SEMANTIC_DISABLED');
  });

  it('returns SEMANTIC_DISABLED before validating rebuild_semantic_index args', async () => {
    const result = await rebuildSemanticIndex({}, { semantic: undefined } as any);

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

  it('forwards all semantic_search filters through the semantic service', async () => {
    const calls: any[] = [];
    const ctx: any = {
      semantic: {
        search: async (input: any) => {
          calls.push(input);
          return [];
        },
      },
    };

    await semanticSearch({
      query: 'cliente pediu valores',
      path: '_journal/alfa',
      type: 'journal',
      tag: 'lead',
      owner: ['alfa', 'beta'],
      min_score: 0.82,
      limit: 7,
    }, ctx);

    expect(calls[0]).toEqual({
      query: 'cliente pediu valores',
      minScore: 0.82,
      limit: 7,
      filter: { path: '_journal/alfa', type: 'journal', tag: 'lead', owner: ['alfa', 'beta'] },
    });
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

  it('forwards force through rebuild_semantic_index', async () => {
    const calls: any[] = [];
    const ctx: any = {
      semantic: {
        rebuild: async (input: any) => {
          calls.push(input);
          return { indexed: 0, skipped: 0, deleted: 0, errors: [] };
        },
      },
    };

    await rebuildSemanticIndex({ as_agent: 'alfa', force: true }, ctx);

    expect(calls[0]).toMatchObject({ asAgent: 'alfa', force: true });
  });

  it('registers semantic tools in tools/list', async () => {
    process.env.API_KEY = 't';
    process.env.VAULT_PATH = '/tmp/mcp-obsidian-baseline';
    const { createMcpServer } = await import('../../src/server.js');
    const server = createMcpServer();
    const listTools = (server as any)._requestHandlers.get('tools/list');

    const result = await listTools({ method: 'tools/list', params: {} });
    const names = result.tools.map((tool: any) => tool.name);
    const semanticTool = result.tools.find((tool: any) => tool.name === 'semantic_search');
    const rebuildTool = result.tools.find((tool: any) => tool.name === 'rebuild_semantic_index');

    expect(names).toEqual(expect.arrayContaining(['semantic_search', 'rebuild_semantic_index']));
    expect(semanticTool.description).toContain('Semantic memory search');
    expect(semanticTool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(semanticTool.inputSchema.properties).toHaveProperty('query');
    expect(rebuildTool.description).toContain('Rebuild semantic memory index');
    expect(rebuildTool.annotations).toEqual({ openWorldHint: false });
    expect(rebuildTool.inputSchema.properties).toHaveProperty('as_agent');
  });

  it('keeps semantic tool listing side-effect free in the server', async () => {
    process.env.API_KEY = 't';
    process.env.VAULT_PATH = '/tmp/mcp-obsidian-baseline-does-not-need-to-exist';
    const { createMcpServer } = await import('../../src/server.js');
    const server = createMcpServer();
    const listTools = (server as any)._requestHandlers.get('tools/list');

    const result = await listTools({ method: 'tools/list', params: {} });

    expect(result.tools.map((tool: any) => tool.name)).toContain('semantic_search');
  });
});
