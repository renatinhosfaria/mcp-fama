import pg from 'pg';
import type { PoolClient } from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  statement_timeout: config.queryTimeoutMs,
  idle_in_transaction_session_timeout: 30000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

export async function query(sql: string, params?: unknown[], timeoutMs?: number) {
  const client = await pool.connect();
  try {
    if (timeoutMs) {
      await client.query(`SET statement_timeout = ${timeoutMs}`);
    }
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
