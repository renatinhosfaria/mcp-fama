import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare module 'express-serve-static-core' {
  interface Request { requestId: string; }
}

export function requestId(req: Request, _res: Response, next: NextFunction) {
  req.requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  next();
}
