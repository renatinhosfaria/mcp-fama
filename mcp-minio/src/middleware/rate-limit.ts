import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { config } from '../config.js';

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimitRpm,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: 'Too many requests, try again later' },
});
