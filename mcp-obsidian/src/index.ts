import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { loggerMiddleware, log } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { createMcpServer } from './server.js';
import { getLastWriteTs } from './last-write.js';

const app = express();
app.use(helmet());
app.use(requestId);
app.use(loggerMiddleware);

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    vault_notes: 0,           // populated once index is built (Phase F)
    index_age_ms: 0,
    git_head: null,
    last_write_ts: getLastWriteTs(),
  });
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

app.listen(config.port, '0.0.0.0', () => {
  log({ timestamp: new Date().toISOString(), level: 'info', message: `listening on :${config.port}` });
});
