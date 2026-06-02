import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  evaluateSemanticResults,
  type SemanticEvalCase,
} from '../src/vault/semantic/eval.js';

type EvalCaseConfig = Omit<SemanticEvalCase, 'actualPaths'>;

export type JsonRpcResponse = {
  result?: {
    structuredContent?: unknown;
  };
  error?: {
    message?: string;
  };
};

const cases: EvalCaseConfig[] = [
  {
    query: 'lead pediu tabela de valores e financiamento',
    expectedPaths: ['_journal/alfa/2026-05-11-atendimento.md'],
  },
  {
    query: 'procedimento operacional para corretor sem resposta',
    expectedPaths: ['_runbooks/alfa-vault-operacao.md'],
  },
];

function numericEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function fetchSemanticPaths(query: string, id: number, mcpUrl: string, apiKey: string): Promise<string[]> {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'semantic_search',
        arguments: { query, limit: 5 },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP semantic_search failed with HTTP ${response.status}.`);
  }

  const payload = await parseJsonRpcResponse(response);
  return extractSemanticMatchPaths(payload);
}

export function extractSemanticMatchPaths(payload: JsonRpcResponse): string[] {
  if (payload.error) {
    throw new Error(`MCP semantic_search failed: ${payload.error.message ?? 'unknown JSON-RPC error'}`);
  }

  const structuredContent = payload.result?.structuredContent;
  if (!isRecord(structuredContent)) {
    throw new Error('MCP semantic_search contract error: result.structuredContent must be an object.');
  }

  if (!Array.isArray(structuredContent.matches)) {
    throw new Error('MCP semantic_search contract error: result.structuredContent.matches must be an array.');
  }

  return structuredContent.matches
    .map((match, index) => {
      if (!isRecord(match) || typeof match.path !== 'string') {
        throw new Error(`MCP semantic_search contract error: result.structuredContent.matches[${index}].path must be a string.`);
      }
      return match.path;
    });
}

async function parseJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return (await response.json()) as JsonRpcResponse;
  }

  const text = await response.text();
  return parseJsonRpcSse(text);
}

export function parseJsonRpcSse(text: string): JsonRpcResponse {
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      return JSON.parse(line.slice(5).trimStart()) as JsonRpcResponse;
    }
  }

  throw new Error('MCP semantic_search returned an SSE response without a data event.');
}

export async function main(): Promise<void> {
  if (process.env.SEMANTIC_ENABLED !== 'true') {
    console.log('Semantic memory evaluation skipped: set SEMANTIC_ENABLED=true to run live evaluation.');
    return;
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY is required to call the MCP endpoint.');
  }

  const mcpUrl = process.env.MCP_OBSIDIAN_URL ?? 'http://localhost:3201/mcp';
  const evaluatedCases = await Promise.all(
    cases.map(async (evalCase, index): Promise<SemanticEvalCase> => ({
      ...evalCase,
      actualPaths: await fetchSemanticPaths(evalCase.query, index + 1, mcpUrl, apiKey),
    })),
  );

  const result = evaluateSemanticResults(evaluatedCases);
  console.log(JSON.stringify({
    cases: result.cases,
    evaluatedCases,
    hitRateAt5: result.hitRateAt5,
    meanReciprocalRank: result.meanReciprocalRank,
  }, null, 2));

  if (process.env.SEMANTIC_EVAL_STRICT === 'true') {
    const minHitRate = numericEnv('SEMANTIC_EVAL_MIN_HIT_RATE', 0.5);
    const minMrr = numericEnv('SEMANTIC_EVAL_MIN_MRR', 0.5);
    if (result.hitRateAt5 < minHitRate || result.meanReciprocalRank < minMrr) {
      throw new Error(`Semantic evaluation below thresholds: hitRateAt5=${result.hitRateAt5}, meanReciprocalRank=${result.meanReciprocalRank}.`);
    }
  }
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectExecution()) {
  await main();
}
