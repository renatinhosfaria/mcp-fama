import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/health') return next();
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || token !== config.apiKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
