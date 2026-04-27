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

export const config = {
  port: parseInt(optional('PORT', '3201'), 10),
  apiKey: loadApiKey(),
  vaultPath: required('VAULT_PATH'),
  rateLimitRpm: parseInt(optional('RATE_LIMIT_RPM', '300'), 10),
  syncEnabled: parseBool(optional('SYNC_ENABLED', 'true')),
  syncIntervalMs: parseInt(optional('SYNC_INTERVAL_MS', '30000'), 10),
  gitRemote: optional('GIT_REMOTE', 'origin'),
  gitBranch: optional('GIT_BRANCH', 'main'),
};
