import 'dotenv/config';
import fs from 'node:fs';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env var: ${name}`);
  return v;
}
function optional(name: string, def: string): string {
  return process.env[name] ?? def;
}

function parseIntEnv(name: string, def: string): number {
  return parseInt(optional(name, def), 10);
}

function parseFloatEnv(name: string, def: string): number {
  return parseFloat(optional(name, def));
}

function parseCsv(name: string): string[] {
  return optional(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLegacyToolMode(): 'redirect' | 'error' {
  const v = optional('LEGACY_TOOL_MODE', 'redirect');
  if (v !== 'redirect' && v !== 'error') throw new Error('LEGACY_TOOL_MODE must be redirect or error');
  return v;
}

function loadApiKey(): string {
  const keyFile = process.env.API_KEY_FILE;
  if (keyFile && keyFile.trim() !== '') {
    try {
      const content = fs.readFileSync(keyFile, 'utf8').trim();
      if (content) return content;
    } catch (e: any) {
      throw new Error(`API_KEY_FILE set to ${keyFile} but could not read: ${e.message}`);
    }
  }
  return required('API_KEY');
}

function parseBool(s: string): boolean {
  return s.toLowerCase() === 'true' || s === '1';
}

function buildSemanticConfig() {
  const enabled = parseBool(optional('SEMANTIC_ENABLED', 'false'));
  const databaseUrl = optional('SEMANTIC_DATABASE_URL', '');
  const openaiApiKey = optional('OPENAI_API_KEY', '');

  if (enabled && !databaseUrl) {
    throw new Error('SEMANTIC_DATABASE_URL is required when SEMANTIC_ENABLED=true');
  }
  if (enabled && !openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required when SEMANTIC_ENABLED=true');
  }

  return {
    enabled,
    databaseUrl,
    openaiApiKey,
    embeddingModel: optional('SEMANTIC_EMBEDDING_MODEL', 'text-embedding-3-large'),
    embeddingDimensions: parseIntEnv('SEMANTIC_EMBEDDING_DIMENSIONS', '3072'),
    minScore: parseFloatEnv('SEMANTIC_MIN_SCORE', '0.75'),
    maxResults: parseIntEnv('SEMANTIC_MAX_RESULTS', '5'),
    previewChars: parseIntEnv('SEMANTIC_PREVIEW_CHARS', '600'),
  };
}

export const config = {
  port: parseIntEnv('PORT', '3201'),
  apiKey: loadApiKey(),
  vaultPath: required('VAULT_PATH'),
  rateLimitRpm: parseIntEnv('RATE_LIMIT_RPM', '300'),
  syncEnabled: parseBool(optional('SYNC_ENABLED', 'true')),
  syncIntervalMs: parseIntEnv('SYNC_INTERVAL_MS', '30000'),
  gitRemote: optional('GIT_REMOTE', 'origin'),
  gitBranch: optional('GIT_BRANCH', 'main'),
  legacyToolMode: parseLegacyToolMode(),
  humanVerifiers: parseCsv('HUMAN_VERIFIERS'),
  defaultAgentSource: optional('DEFAULT_AGENT_SOURCE', 'agent-generated'),
  defaultDateStyle: optional('DEFAULT_DATE_STYLE', 'yyyy-mm-dd'),
  semantic: buildSemanticConfig(),
};
