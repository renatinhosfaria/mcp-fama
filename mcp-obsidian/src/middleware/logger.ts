import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';

const AUDIT_PATH = path.resolve('logs/audit.log');
fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'audit';
  request_id?: string;
  tool?: string;
  as_agent?: string;
  path?: string;
  duration_ms?: number;
  outcome?: 'ok' | 'error';
  audit?: boolean;
  message?: string;
  [extra: string]: unknown;
}

export function log(entry: LogEntry): void {
  const line = JSON.stringify({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
  process.stdout.write(line + '\n');
  if (entry.audit) {
    fs.appendFileSync(AUDIT_PATH, line + '\n');
  }
}

export function loggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    log({
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 400 ? 'error' : 'info',
      request_id: req.requestId,
      message: `${req.method} ${req.path} ${res.statusCode}`,
      duration_ms: Date.now() - start,
    });
  });
  next();
}
