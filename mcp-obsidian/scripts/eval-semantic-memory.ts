import 'dotenv/config';
import {
  evaluateSemanticResults,
  type SemanticEvalCase,
} from '../src/vault/semantic/eval.js';

type EvalCaseConfig = Omit<SemanticEvalCase, 'actualPaths'>;

type JsonRpcResponse = {
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

if (process.env.SEMANTIC_ENABLED !== 'true') {
  console.log('Semantic memory evaluation skipped: set SEMANTIC_ENABLED=true to run live evaluation.');
  process.exit(0);
}

const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('API_KEY is required to call the MCP endpoint.');
}

const mcpUrl = process.env.MCP_OBSIDIAN_URL ?? 'http://localhost:3201/mcp';

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

async function fetchSemanticPaths(query: string, id: number): Promise<string[]> {
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
  if (payload.error) {
    throw new Error(`MCP semantic_search failed: ${payload.error.message ?? 'unknown JSON-RPC error'}`);
  }

  const structuredContent = payload.result?.structuredContent;
  if (!isRecord(structuredContent) || !Array.isArray(structuredContent.matches)) {
    return [];
  }

  return structuredContent.matches
    .map((match) => (isRecord(match) && typeof match.path === 'string' ? match.path : undefined))
    .filter((path): path is string => Boolean(path));
}

async function parseJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return (await response.json()) as JsonRpcResponse;
  }

  const text = await response.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6)) as JsonRpcResponse;
    }
  }

  throw new Error('MCP semantic_search returned an SSE response without a data event.');
}

const evaluatedCases = await Promise.all(
  cases.map(async (evalCase, index): Promise<SemanticEvalCase> => ({
    ...evalCase,
    actualPaths: await fetchSemanticPaths(evalCase.query, index + 1),
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
