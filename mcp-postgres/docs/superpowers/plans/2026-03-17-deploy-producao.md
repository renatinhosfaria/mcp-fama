# Deploy em Produção Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the MCP PostgreSQL server as a Docker Swarm stack on the existing VPS with HTTPS via Traefik.

**Architecture:** Multi-stage Docker build produces a lean production image. Docker Compose file defines a Swarm stack with Traefik labels for automatic HTTPS routing. Code changes add graceful shutdown and fix rate limiter to exclude health checks.

**Tech Stack:** Docker, Docker Swarm, Traefik 2.11, Node.js 20 Alpine, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-17-deploy-producao-design.md`

---

### Task 1: Create .gitignore

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Create .gitignore file**

```
node_modules/
dist/
.env
docker-compose.yml
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore"
```

---

### Task 2: Create .dockerignore

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Create .dockerignore file**

```
node_modules
dist
.env
.git
.claude
docs
*.md
```

- [ ] **Step 2: Commit**

```bash
git add .dockerignore
git commit -m "chore: add .dockerignore"
```

---

### Task 3: Fix rate limiter to exclude /health

The Swarm healthcheck hits `/health` frequently. The rate limiter (60 req/min) must not count these requests, or it can cause false health failures.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Move the health check route BEFORE the rate limiter middleware**

In `src/index.ts`, the current middleware order is:

```typescript
app.use(helmet());
app.use(loggerMiddleware);
app.use(rateLimiter);
app.use(authMiddleware);

// Health check (no auth)
app.get('/health', async (_req, res) => { ... });
```

Change to:

```typescript
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
```

- [ ] **Step 2: Verify the app still compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: exclude /health from rate limiter"
```

---

### Task 4: Add graceful shutdown

When Swarm sends SIGTERM, the server should stop accepting new connections and drain the database pool before exiting.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add graceful shutdown handler**

At the bottom of `src/index.ts`, after `app.listen(...)`, add:

```typescript
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[SERVER] MCP PostgreSQL server listening on port ${config.port}`);
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
```

This requires importing `pool` from `./db.js`. Add to the imports at the top:

```typescript
import { healthCheck, pool } from './db.js';
```

And update the existing import line that only imports `healthCheck`.

- [ ] **Step 2: Verify the app still compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add graceful shutdown on SIGTERM/SIGINT"
```

---

### Task 5: Create Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create multi-stage Dockerfile**

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3100
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Build the image to verify it works**

Run: `docker build -t mcp-postgres .`
Expected: Build completes successfully, final image uses `node` user and runs `node dist/index.js`

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-stage Dockerfile for production"
```

---

### Task 6: Create docker-compose.yml

This file contains production credentials and is NOT committed to git (it's in `.gitignore`). It lives only on the VPS.

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create docker-compose.yml for Swarm**

```yaml
version: "3.8"

services:
  mcp-postgres:
    image: mcp-postgres:latest
    networks:
      - network_public
    environment:
      - DATABASE_URL=postgresql://postgres:IwOLgVnyOfbN@postgres_postgres:5432/neondb
      - API_KEY=79f9cd8a-3b42-49c8-a8fa-c7ef9100b7d3
      - PORT=3100
      - DB_POOL_MAX=10
      - QUERY_TIMEOUT_MS=30000
      - RATE_LIMIT_RPM=60
      - NODE_ENV=production
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3100/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "1"
          memory: 1G
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
        window: 120s
      labels:
        - traefik.enable=true
        - traefik.docker.network=network_public
        - "traefik.http.routers.mcp_postgres.rule=Host(`mcp-famachat-postgres.famachat.com.br`)"
        - traefik.http.routers.mcp_postgres.entrypoints=websecure
        - traefik.http.routers.mcp_postgres.tls=true
        - traefik.http.routers.mcp_postgres.tls.certresolver=letsencryptresolver
        - traefik.http.services.mcp_postgres.loadbalancer.server.port=3100

networks:
  network_public:
    external: true
```

- [ ] **Step 2: Verify the compose file is valid**

Run: `docker compose config -q`
Expected: No errors (silent success)

- [ ] **Step 3: Do NOT commit** — this file is in `.gitignore` because it contains credentials.

---

### Task 7: Deploy to Swarm

- [ ] **Step 1: Build the production image**

Run: `docker build -t mcp-postgres .`
Expected: Build succeeds

- [ ] **Step 2: Deploy the stack**

Run: `docker stack deploy -c docker-compose.yml mcp-postgres`
Expected: `Creating service mcp-postgres_mcp-postgres`

- [ ] **Step 3: Verify service is running**

Run: `docker service ls --filter name=mcp-postgres`
Expected: Shows `mcp-postgres_mcp-postgres` with `1/1` replicas

- [ ] **Step 4: Check service logs**

Run: `docker service logs mcp-postgres_mcp-postgres --tail 20`
Expected: Shows `[SERVER] MCP PostgreSQL server listening on port 3100`

- [ ] **Step 5: Test health endpoint**

Run: `curl -s https://mcp-famachat-postgres.famachat.com.br/health | head`
Expected: JSON with `"status": "healthy"` and `"database": "connected"`

- [ ] **Step 6: Test MCP endpoint requires auth**

Run: `curl -s -X POST https://mcp-famachat-postgres.famachat.com.br/mcp`
Expected: `401` with `"Missing or invalid Authorization header"`

- [ ] **Step 7: Test MCP endpoint with auth**

Run:
```bash
curl -s -X POST https://mcp-famachat-postgres.famachat.com.br/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 79f9cd8a-3b42-49c8-a8fa-c7ef9100b7d3" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
```
Expected: JSON-RPC response with server info (name: `postgres-neondb`, version: `1.0.0`)
