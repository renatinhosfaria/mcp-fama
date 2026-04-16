import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, def: string): string {
  return process.env[name] ?? def;
}

export const config = {
  port: parseInt(optional('PORT', '3201'), 10),
  apiKey: required('API_KEY'),
  vaultPath: required('VAULT_PATH'),
  rateLimitRpm: parseInt(optional('RATE_LIMIT_RPM', '300'), 10),
  gitAuthorName: optional('GIT_AUTHOR_NAME', 'mcp-obsidian'),
  gitAuthorEmail: optional('GIT_AUTHOR_EMAIL', 'mcp@fama.local'),
  gitLockfile: optional('GIT_LOCKFILE', '/tmp/brain-sync.lock'),
  strictWikilinks: optional('STRICT_WIKILINKS', 'false') === 'true',
  logLevel: optional('LOG_LEVEL', 'info') as 'info' | 'warn' | 'error' | 'debug',
};
