import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3100', 10),
  databaseUrl: process.env.DATABASE_URL!,
  apiKey: process.env.API_KEY!,
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
  queryTimeoutMs: parseInt(process.env.QUERY_TIMEOUT_MS || '30000', 10),
  rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '300', 10),
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.apiKey) throw new Error('API_KEY is required');
