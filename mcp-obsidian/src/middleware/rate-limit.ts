import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.rateLimitRpm,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});
