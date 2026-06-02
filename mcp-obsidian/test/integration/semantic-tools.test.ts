import { describe, expect, it } from 'vitest';
import type { McpToolResponse } from '../../src/errors.js';
import type { ToolCtx } from '../../src/tools/_shared.js';
import { rebuildSemanticIndex, semanticSearch } from '../../src/tools/semantic.js';
import type { SemanticMemoryService } from '../../src/vault/semantic/service.js';
import type {
  SemanticRebuildInput,
  SemanticSearchInput,
  SemanticSearchResult,
} from '../../src/vault/semantic/types.js';
import type { VaultIndex } from '../../src/vault/index.js';

type SemanticDisabledContent = {
  error?: {
    code?: string;
  };
};

type SemanticSearchContent = {
  matches?: unknown[];
};

type RebuildContent = {
  indexed?: number;
};

type ListedTool = {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  inputSchema: {
    properties: Record<string, unknown>;
  };
};

type ListToolsHandler = (request: {
  method: 'tools/list';
  params: Record<string, unknown>;
}) => Promise<{ tools: ListedTool[] }>;

type ServerWithRequestHandlers = {
  _requestHandlers: Map<string, ListToolsHandler>;
};

const fakeIndex = {} as VaultIndex;

function disabledCtx(): ToolCtx {
  return { index: fakeIndex, vaultRoot: '/tmp/vault', semantic: undefined };
}

function semanticCtx(semantic: Partial<SemanticMemoryService>): ToolCtx {
  return {
    index: fakeIndex,
    vaultRoot: '/tmp/vault',
    semantic: semantic as SemanticMemoryService,
  };
}

function structured<T>(result: McpToolResponse): T {
  return result.structuredContent as T;
}

function listToolsHandler(server: unknown): ListToolsHandler {
  return (server as ServerWithRequestHandlers)._requestHandlers.get('tools/list')!;
}

describe('semantic tools', () => {
  it('returns SEMANTIC_DISABLED when semantic service is not configured', async () => {
    const result = await semanticSearch({ query: 'cliente pediu valores' }, disabledCtx());

    expect(result.isError).toBe(true);
    expect(structured<SemanticDisabledContent>(result).error?.code).toBe('SEMANTIC_DISABLED');
  });

  it('returns SEMANTIC_DISABLED before validating semantic_search args', async () => {
    const result = await semanticSearch({}, disabledCtx());

    expect(result.isError).toBe(true);
    expect(structured<SemanticDisabledContent>(result).error?.code).toBe('SEMANTIC_DISABLED');
  });

  it('returns SEMANTIC_DISABLED before validating rebuild_semantic_index args', async () => {
    const result = await rebuildSemanticIndex({}, disabledCtx());

    expect(result.isError).toBe(true);
    expect(structured<SemanticDisabledContent>(result).error?.code).toBe('SEMANTIC_DISABLED');
  });

  it('runs semantic_search through the semantic service', async () => {
    const calls: SemanticSearchInput[] = [];
    const ctx = semanticCtx({
      search: async (input: SemanticSearchInput): Promise<SemanticSearchResult[]> => {
        calls.push(input);
        return [{ path: 'a.md', chunk_id: 'a', chunk_index: 0, heading: 'A', heading_path: ['A'], preview: 'preview', owner: 'alfa', type: 'journal', tags: [], score: 0.9, source: 'hybrid' }];
      },
    });

    const result = await semanticSearch({ query: 'cliente pediu valores', owner: 'alfa', limit: 5 }, ctx);

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ query: 'cliente pediu valores', limit: 5 });
    expect(structured<SemanticSearchContent>(result).matches).toHaveLength(1);
  });

  it('forwards all semantic_search filters through the semantic service', async () => {
    const calls: SemanticSearchInput[] = [];
    const ctx = semanticCtx({
      search: async (input: SemanticSearchInput): Promise<SemanticSearchResult[]> => {
        calls.push(input);
        return [];
      },
    });

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
    const calls: SemanticRebuildInput[] = [];
    const ctx = semanticCtx({
      rebuild: async (input: SemanticRebuildInput) => {
        calls.push(input);
        return { indexed: 2, skipped: 1, deleted: 0, errors: [] };
      },
    });

    const result = await rebuildSemanticIndex({ as_agent: 'alfa', path: '_journal/alfa', limit: 10 }, ctx);

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ asAgent: 'alfa', path: '_journal/alfa', limit: 10 });
    expect(structured<RebuildContent>(result).indexed).toBe(2);
  });

  it('forwards force through rebuild_semantic_index', async () => {
    const calls: SemanticRebuildInput[] = [];
    const ctx = semanticCtx({
      rebuild: async (input: SemanticRebuildInput) => {
        calls.push(input);
        return { indexed: 0, skipped: 0, deleted: 0, errors: [] };
      },
    });

    await rebuildSemanticIndex({ as_agent: 'alfa', force: true }, ctx);

    expect(calls[0]).toMatchObject({ asAgent: 'alfa', force: true });
  });

  it('registers semantic tools in tools/list', async () => {
    process.env.API_KEY = 't';
    process.env.VAULT_PATH = '/tmp/mcp-obsidian-baseline';
    const { createMcpServer } = await import('../../src/server.js');
    const server = createMcpServer();
    const listTools = listToolsHandler(server);

    const result = await listTools({ method: 'tools/list', params: {} });
    const names = result.tools.map((tool) => tool.name);
    const semanticTool = result.tools.find((tool) => tool.name === 'semantic_search');
    const rebuildTool = result.tools.find((tool) => tool.name === 'rebuild_semantic_index');

    expect(names).toEqual(expect.arrayContaining(['semantic_search', 'rebuild_semantic_index']));
    expect(semanticTool?.description).toContain('Semantic memory search');
    expect(semanticTool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(semanticTool?.inputSchema.properties).toHaveProperty('query');
    expect(rebuildTool?.description).toContain('Rebuild semantic memory index');
    expect(rebuildTool?.annotations).toEqual({ openWorldHint: false });
    expect(rebuildTool?.inputSchema.properties).toHaveProperty('as_agent');
  });

  it('keeps semantic tool listing side-effect free in the server', async () => {
    process.env.API_KEY = 't';
    process.env.VAULT_PATH = '/tmp/mcp-obsidian-baseline-does-not-need-to-exist';
    const { createMcpServer } = await import('../../src/server.js');
    const server = createMcpServer();
    const listTools = listToolsHandler(server);

    const result = await listTools({ method: 'tools/list', params: {} });

    expect(result.tools.map((tool) => tool.name)).toContain('semantic_search');
  });
});
