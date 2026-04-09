import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { loggerMiddleware } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthCheck, pool } from './db.js';
import { createMcpServer } from './server.js';

const app = express();

// Middleware stack
app.use(helmet());
app.use(loggerMiddleware);

// Health check — before rate limiter and auth
app.get('/health', async (_req, res) => {
  const dbOk = await healthCheck();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'healthy' : 'unhealthy',
    database: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

app.use(rateLimiter);
app.use(authMiddleware);

// MCP endpoint - POST (stateless: each request gets its own transport + server)
app.post('/mcp', express.json(), async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode — no session tracking
  });

  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});

// MCP endpoint - GET (SSE not needed in stateless mode)
app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'SSE not supported in stateless mode. Use POST.' });
});

// MCP endpoint - DELETE (no sessions to close in stateless mode)
app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'No sessions to close in stateless mode.' });
});

// Error handler
app.use(errorHandler);

// Start server
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[SERVER] MCP PostgreSQL Financas server listening on port ${config.port} (stateless mode)`);
  console.log(`[SERVER] Health: http://0.0.0.0:${config.port}/health`);
  console.log(`[SERVER] MCP:    http://0.0.0.0:${config.port}/mcp`);
});

function shutdown(signal: string) {
  console.log(`[SERVER] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('[SERVER] HTTP server closed');
    pool.end().then(() => {
      console.log('[SERVER] Database pool closed');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
