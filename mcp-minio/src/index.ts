import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { loggerMiddleware } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthCheck } from './minio.js';
import { createMcpServer } from './server.js';

const app = express();

// Middleware stack
app.use(helmet());
app.use(loggerMiddleware);

// Health check — antes do rate limiter e auth
app.get('/health', async (_req, res) => {
  const minioOk = await healthCheck();
  res.status(minioOk ? 200 : 503).json({
    status: minioOk ? 'healthy' : 'unhealthy',
    minio: minioOk ? 'connected' : 'disconnected',
    endpoint: config.minio.endPoint,
    timestamp: new Date().toISOString(),
  });
});

// OAuth 2.1 / MCP spec discovery endpoints — públicos, sem autenticação
// Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
// RFC 9728: OAuth 2.0 Protected Resource Metadata
const RESOURCE_URL = `https://${config.minio.endPoint.includes('localhost') ? 'mcp-minio.famachat.com.br' : 'mcp-minio.famachat.com.br'}`;

// Retorna metadata de recurso: servidor Bearer-only, sem OAuth server
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({ resource: RESOURCE_URL, bearer_methods_supported: ['header'] });
});
app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  res.json({ resource: RESOURCE_URL, bearer_methods_supported: ['header'] });
});

// Sem servidor OAuth — retorna 404 para o cliente usar token estático
app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.status(404).json({ error: 'OAuth authorization server not supported. Use static Bearer token.' });
});
app.get('/.well-known/openid-configuration', (_req, res) => {
  res.status(404).json({ error: 'OpenID Connect not supported. Use static Bearer token.' });
});

// Dynamic client registration não suportado
app.post('/register', (_req, res) => {
  res.status(400).json({ error: 'Dynamic client registration not supported. Use static Bearer token.' });
});

app.use(rateLimiter);
app.use(authMiddleware);

// MCP endpoint - POST (stateless: cada requisição cria transport + server próprios)
app.post('/mcp', express.json(), async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // modo stateless — sem rastreamento de sessão
  });

  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});

// MCP endpoint - GET (SSE não suportado em modo stateless)
app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'SSE not supported in stateless mode. Use POST.' });
});

// MCP endpoint - DELETE (sem sessões em modo stateless)
app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'No sessions to close in stateless mode.' });
});

// Error handler global
app.use(errorHandler);

// Start server
const httpServer = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[SERVER] MCP MinIO server listening on port ${config.port} (stateless mode)`);
  console.log(`[SERVER] Endpoint: ${config.minio.useSSL ? 'https' : 'http'}://${config.minio.endPoint}:${config.minio.port}`);
  console.log(`[SERVER] Health:   http://0.0.0.0:${config.port}/health`);
  console.log(`[SERVER] MCP:      http://0.0.0.0:${config.port}/mcp`);
});

function shutdown(signal: string) {
  console.log(`[SERVER] ${signal} received, shutting down gracefully...`);
  httpServer.close(() => {
    console.log('[SERVER] HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
