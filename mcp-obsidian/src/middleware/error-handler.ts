import type { ErrorRequestHandler } from 'express';
import { log } from './logger.js';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  log({
    timestamp: new Date().toISOString(),
    level: 'error',
    request_id: req.requestId,
    message: err?.message ?? 'unknown error',
    stack: err?.stack,
  });
  res.status(500).json({ error: 'internal error' });
};
