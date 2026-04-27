import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { loggerMiddleware, log } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { createMcpServer, __getSharedCtxForHealth } from './server.js';
import { getLastWriteTs } from './last-write.js';

const app = express();
app.use(helmet());
app.use(requestId);
app.use(loggerMiddleware);

app.get('/health', async (_req, res) => {
  try {
    const ctx = await __getSharedCtxForHealth();
    const gitHead = ctx.git ? await ctx.git.head() : null;
    const workerStatus = ctx.worker ? ctx.worker.getStatus() : { enabled: false };
    res.status(200).json({
      status: 'healthy',
      vault_notes: ctx.index.size(),
      index_age_ms: ctx.index.ageMs(),
      git_head: gitHead,
      last_write_ts: getLastWriteTs(),
      sync_worker: ctx.worker ? { enabled: true, ...workerStatus } : { enabled: false },
    });
  } catch (e: any) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

app.use(rateLimiter);
app.use(authMiddleware);

app.post('/mcp', express.json(), async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});
app.get('/mcp', (_req, res) => { res.status(405).json({ error: 'SSE not supported in stateless mode' }); });
app.delete('/mcp', (_req, res) => { res.status(405).json({ error: 'No sessions to close' }); });

app.use(errorHandler);

const httpServer = app.listen(config.port, '0.0.0.0', () => {
  log({ timestamp: new Date().toISOString(), level: 'info', message: `listening on :${config.port}` });
});

async function shutdown(signal: string): Promise<void> {
  log({ timestamp: new Date().toISOString(), level: 'info', message: `received ${signal}, shutting down` });
  const ctx = await __getSharedCtxForHealth().catch(() => null);
  if (ctx?.worker) {
    const drainTimeout = setTimeout(() => {
      log({ timestamp: new Date().toISOString(), level: 'warn', message: 'sync-worker drain timeout, forcing exit' });
      process.exit(0);
    }, 10_000);
    try { await ctx.worker.stop(); } catch (e: any) {
      log({ timestamp: new Date().toISOString(), level: 'error', message: `worker stop failed: ${e.message}` });
    }
    clearTimeout(drainTimeout);
  }
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
