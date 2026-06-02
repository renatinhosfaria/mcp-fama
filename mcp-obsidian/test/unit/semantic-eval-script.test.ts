import { afterEach, describe, expect, it, vi } from 'vitest';

type JsonRpcResponse = {
  result?: {
    structuredContent?: unknown;
  };
  error?: {
    message?: string;
  };
};

type EvalScriptModule = {
  extractSemanticMatchPaths: (payload: JsonRpcResponse) => string[];
  parseJsonRpcSse: (text: string) => JsonRpcResponse;
};

async function importEvalScript(): Promise<EvalScriptModule> {
  vi.resetModules();
  process.env.SEMANTIC_ENABLED = 'true';
  process.env.API_KEY = 't';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ result: { structuredContent: { matches: [] } } }),
  })));

  return await import('../../scripts/eval-semantic-memory.ts') as EvalScriptModule;
}

afterEach(() => {
  delete process.env.SEMANTIC_ENABLED;
  delete process.env.API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('semantic eval script helpers', () => {
  it('throws a clear contract error when semantic matches are missing', async () => {
    const { extractSemanticMatchPaths } = await importEvalScript();

    expect(() => extractSemanticMatchPaths({
      result: { structuredContent: { unexpected: [] } },
    })).toThrow(/structuredContent\.matches.*array/i);
  });

  it('extracts semantic match paths from a valid MCP payload', async () => {
    const { extractSemanticMatchPaths } = await importEvalScript();

    expect(extractSemanticMatchPaths({
      result: { structuredContent: { matches: [{ path: 'x.md' }] } },
    })).toEqual(['x.md']);
  });

  it('parses SSE data events without a space after the colon', async () => {
    const { parseJsonRpcSse } = await importEvalScript();

    expect(parseJsonRpcSse('data:{"result":{"structuredContent":{"matches":[]}}}')).toEqual({
      result: { structuredContent: { matches: [] } },
    });
  });

  it('parses SSE data events with a space after the colon', async () => {
    const { parseJsonRpcSse } = await importEvalScript();

    expect(parseJsonRpcSse('event: message\ndata: {"result":{"structuredContent":{"matches":[]}}}')).toEqual({
      result: { structuredContent: { matches: [] } },
    });
  });

  it('does not call MCP when helpers are imported', async () => {
    await importEvalScript();

    expect(fetch).not.toHaveBeenCalled();
  });
});
