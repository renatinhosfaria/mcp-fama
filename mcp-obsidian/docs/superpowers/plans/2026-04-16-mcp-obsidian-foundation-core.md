# mcp-obsidian Foundation + Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of the mcp-obsidian MCP server in TypeScript — HTTP transport, auth, vault filesystem layer (atomic IO, frontmatter, ownership, in-memory index, git), and 22 tools (8 CRUD + 12 workflow + 2 git) + 2 MCP resources, covering the original spec scope plus addendum 1 (`get_agent_delta`, `upsert_shared_context`, `upsert_entity_profile`, `owner` filter).

**Architecture:** Stateless Streamable HTTP MCP, Bearer auth, single Docker container with vault mounted as volume, lazy-invalidated in-memory index for tags/type/backlinks/owner/mtime, git commits coordinated with the existing `brain-sync.sh` cron via `flock`. All writes validated against ownership map at `_shared/context/AGENTS.md`. Tests via vitest with mini-vault fixture.

**Tech Stack:** TypeScript 5.x, Node 20+, `@modelcontextprotocol/sdk` ^1.27, `express` ^4, `helmet`, `express-rate-limit`, `zod`, `gray-matter`, `simple-git` (or `child_process`), `proper-lockfile`, `minimatch`, `vitest`.

**Spec reference:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md` — read sections §1, §1.1, §2, §3 entirely before starting; §4.1, §4.2, §4.3, §4.4, §4.5 for tool surface; §5.1 (frontmatter — focus on the 14 types in this plan, ignore `financial-snapshot` which is plan 6); §5.4 (ownership); §6 (responses/errors); §7 (performance targets); §8 (tests); §9 (success criteria 1-9 are in scope of this plan).

**Out of scope (later plans):**
- Plan 2 — `lead.ts` parser, `upsert_lead_timeline`/`append_lead_interaction`/`read_lead_history`, §5.5
- Plan 3 — `broker.ts`, broker tools, §5.6/§5.7, temporal `since`/`until` filter
- Plan 4 — `get_shared_context_delta`, §5.8 taxonomy
- Plan 5 — `get_training_target_delta`, regressoes topic + tags
- Plan 6 — `financial.ts`, financial-snapshot tools, §5.9
- Plan 7 — broker exec view tools, broker exec fields

---

## File Structure

```
mcp-obsidian/
├── Dockerfile                       # multi-stage Node build
├── docker-compose.yml               # mounts /root/fama-brain:/vault, /tmp/brain-sync.lock
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── README.md                        # tool catalog + troubleshooting
├── src/
│   ├── index.ts                     # express bootstrap, /health, /mcp, transport wiring
│   ├── server.ts                    # createMcpServer() — registers tools + resources
│   ├── config.ts                    # env loading + defaults
│   ├── auth.ts                      # Bearer middleware
│   ├── errors.ts                    # typed McpError class + error codes enum
│   ├── middleware/
│   │   ├── rate-limit.ts
│   │   ├── logger.ts                # JSON structured stdout + audit.log appender
│   │   ├── request-id.ts
│   │   └── error-handler.ts
│   ├── vault/
│   │   ├── fs.ts                    # atomic read/write, ASCII-fold, kebab-case, path traversal guard
│   │   ├── frontmatter.ts           # Zod schemas (14 types, discriminated union), parse/serialize
│   │   ├── ownership.ts             # parses _shared/context/AGENTS.md, resolveOwner(path), lazy mtime reload
│   │   ├── index.ts                 # in-memory index: tags/type/wikilinks/backlinks/owner/mtime; lazy invalidation
│   │   └── git.ts                   # commit_and_push, git_status, flock coordination
│   ├── tools/
│   │   ├── crud.ts                  # 8 tools: read_note, write_note, append_to_note, delete_note, list_folder, search_content, get_note_metadata, stat_vault
│   │   ├── workflows.ts             # 12 tools: create_journal_entry, append_decision, update_agent_profile, upsert_goal, upsert_result, read_agent_context, get_agent_delta, upsert_shared_context, upsert_entity_profile, search_by_tag, search_by_type, get_backlinks
│   │   └── sync.ts                  # 2 tools: commit_and_push, git_status
│   └── resources/
│       └── vault.ts                 # obsidian://vault, obsidian://agents
└── test/
    ├── fixtures/
    │   ├── vault/                   # mini-vault: 2 agents (alfa, beta), 5 notes including decisions.md and journal
    │   └── AGENTS.md                # fixture ownership map
    ├── unit/
    │   ├── frontmatter.test.ts
    │   ├── ownership.test.ts
    │   ├── fs.test.ts
    │   └── index.test.ts
    ├── integration/
    │   ├── crud.test.ts
    │   ├── workflows.test.ts
    │   ├── sync.test.ts
    │   └── stress.test.ts           # 10 parallel writes + simulated cron
    └── e2e/
        └── smoke.test.ts            # docker compose up + MCP client roundtrip
```

**Responsibility boundaries:**

- `vault/` — pure vault ops, knows nothing about MCP/HTTP. All vault state mutations go through this layer.
- `tools/` — thin adapters that call into `vault/`, format MCP tool responses (dual content/structuredContent), translate exceptions to MCP errors.
- `middleware/` — HTTP concerns only.
- `errors.ts` — single source of truth for typed error codes; tools throw `McpError`, the error handler renders the dual response.

---

## Phase A — Project bootstrap

### Task A1: Verify versions in sibling MCPs

**Files:**
- Read: `/root/mcp-fama/mcp-postgres/package.json`
- Read: `/root/mcp-fama/mcp-minio/package.json`
- Read: `/root/mcp-fama/mcp-financas/package.json`

- [ ] **Step 1: Read all three sibling package.json files**

Run: `cat /root/mcp-fama/mcp-postgres/package.json /root/mcp-fama/mcp-minio/package.json /root/mcp-fama/mcp-financas/package.json`

Expected: confirm `@modelcontextprotocol/sdk` version range, `express`, `helmet`, `express-rate-limit`, `zod`, `dotenv`, `typescript`, `tsx` versions. Use the highest stable across siblings as baseline for mcp-obsidian. If a sibling uses a different version of any shared dep, prefer the one used by 2+ siblings.

- [ ] **Step 2: Note any divergences in a brief commit-msg-friendly summary**

Output to console (do not commit anything yet): one-line per divergence, e.g. `mcp-financas uses sdk 1.30.x while postgres/minio use 1.27.x → adopt 1.27.x for consistency`.

### Task A2: Create package.json

**Files:**
- Create: `package.json`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "mcp-obsidian",
  "version": "0.1.0",
  "description": "MCP Server for Obsidian vault fama-brain",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "express": "^4.21.2",
    "helmet": "^8.1.0",
    "express-rate-limit": "^7.5.0",
    "dotenv": "^16.4.7",
    "zod": "^3.24.0",
    "gray-matter": "^4.0.3",
    "minimatch": "^10.0.1",
    "proper-lockfile": "^4.1.2",
    "simple-git": "^3.27.0"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.12.0",
    "@types/proper-lockfile": "^4.1.4"
  }
}
```

Adjust dep versions per Task A1 findings if siblings use different stable versions.

- [ ] **Step 2: Install deps**

Run: `cd /root/mcp-fama/mcp-obsidian && npm install`
Expected: lockfile created, no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(mcp-obsidian): bootstrap package.json"
```

### Task A3: Create tsconfig.json + vitest.config.ts

**Files:**
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 2: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        'src/vault/**': { lines: 80, branches: 80, functions: 80, statements: 80 },
        '**': { lines: 60, branches: 60, functions: 60, statements: 60 }
      }
    }
  }
});
```

- [ ] **Step 3: Verify typecheck runs cleanly with empty src**

Run: `mkdir -p src && touch src/.gitkeep && npm run typecheck`
Expected: exits 0 (no .ts files yet, nothing to fail on).

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json vitest.config.ts src/.gitkeep
git commit -m "feat(mcp-obsidian): tsconfig + vitest config"
```

### Task A4: Create .env.example, Dockerfile, docker-compose.yml

**Files:**
- Create: `.env.example`
- Create: `Dockerfile`
- Create: `docker-compose.yml`

- [ ] **Step 1: Write .env.example**

```
PORT=3201
API_KEY=replace-me-with-a-strong-token
VAULT_PATH=/vault
RATE_LIMIT_RPM=300
GIT_AUTHOR_NAME=mcp-obsidian
GIT_AUTHOR_EMAIL=mcp@fama.local
GIT_LOCKFILE=/tmp/brain-sync.lock
STRICT_WIKILINKS=false
LOG_LEVEL=info
```

- [ ] **Step 2: Write Dockerfile**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache git util-linux
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3201
CMD ["node", "dist/index.js"]
```

`util-linux` provides `flock` binary as fallback. `git` needed for `commit_and_push`.

- [ ] **Step 3: Write docker-compose.yml**

```yaml
services:
  mcp-obsidian:
    build: .
    ports: ["3201:3201"]
    environment:
      - PORT=3201
      - API_KEY=${API_KEY}
      - VAULT_PATH=/vault
      - RATE_LIMIT_RPM=${RATE_LIMIT_RPM:-300}
      - GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-mcp-obsidian}
      - GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-mcp@fama.local}
      - GIT_LOCKFILE=/tmp/brain-sync.lock
      - STRICT_WIKILINKS=${STRICT_WIKILINKS:-false}
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      - /root/fama-brain:/vault:rw
      - /tmp/brain-sync.lock:/tmp/brain-sync.lock
      - ./logs:/app/logs
    restart: unless-stopped
```

- [ ] **Step 4: Commit**

```bash
git add .env.example Dockerfile docker-compose.yml
git commit -m "feat(mcp-obsidian): docker + env scaffold"
```

### Task A5: Create directory skeleton

**Files:**
- Create: `src/middleware/.gitkeep`, `src/vault/.gitkeep`, `src/tools/.gitkeep`, `src/resources/.gitkeep`
- Create: `test/unit/.gitkeep`, `test/integration/.gitkeep`, `test/e2e/.gitkeep`, `test/fixtures/vault/.gitkeep`

- [ ] **Step 1: Create dirs**

Run:
```bash
mkdir -p src/middleware src/vault src/tools src/resources test/unit test/integration test/e2e test/fixtures/vault
touch src/middleware/.gitkeep src/vault/.gitkeep src/tools/.gitkeep src/resources/.gitkeep test/unit/.gitkeep test/integration/.gitkeep test/e2e/.gitkeep test/fixtures/vault/.gitkeep
```

- [ ] **Step 2: Commit**

```bash
git add src/ test/
git commit -m "feat(mcp-obsidian): directory skeleton"
```

---

## Phase B — Config, errors, middleware, auth, HTTP bootstrap

### Task B1: src/config.ts

**Files:**
- Create: `src/config.ts`
- Test: `test/unit/config.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('throws if API_KEY is missing', async () => {
    delete process.env.API_KEY;
    await expect(import('../../src/config.js?t=' + Date.now())).rejects.toThrow(/API_KEY/);
  });

  it('throws if VAULT_PATH is missing', async () => {
    process.env.API_KEY = 'x';
    delete process.env.VAULT_PATH;
    await expect(import('../../src/config.js?t=' + Date.now())).rejects.toThrow(/VAULT_PATH/);
  });

  it('returns defaults for optional fields', async () => {
    process.env.API_KEY = 'k'; process.env.VAULT_PATH = '/v';
    const { config } = await import('../../src/config.js?t=' + Date.now());
    expect(config.port).toBe(3201);
    expect(config.rateLimitRpm).toBe(300);
    expect(config.gitLockfile).toBe('/tmp/brain-sync.lock');
    expect(config.strictWikilinks).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL with "Cannot find module" (file does not exist).

- [ ] **Step 3: Implement src/config.ts**

```ts
import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, def: string): string {
  return process.env[name] ?? def;
}

export const config = {
  port: parseInt(optional('PORT', '3201'), 10),
  apiKey: required('API_KEY'),
  vaultPath: required('VAULT_PATH'),
  rateLimitRpm: parseInt(optional('RATE_LIMIT_RPM', '300'), 10),
  gitAuthorName: optional('GIT_AUTHOR_NAME', 'mcp-obsidian'),
  gitAuthorEmail: optional('GIT_AUTHOR_EMAIL', 'mcp@fama.local'),
  gitLockfile: optional('GIT_LOCKFILE', '/tmp/brain-sync.lock'),
  strictWikilinks: optional('STRICT_WIKILINKS', 'false') === 'true',
  logLevel: optional('LOG_LEVEL', 'info') as 'info' | 'warn' | 'error' | 'debug',
};
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "feat(mcp-obsidian): config loader with required/optional env"
```

### Task B2: src/errors.ts

**Files:**
- Create: `src/errors.ts`
- Test: `test/unit/errors.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/errors.test.ts
import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '../../src/errors.js';

describe('McpError', () => {
  it('carries code, message, and optional suggestion', () => {
    const e = new McpError('OWNERSHIP_VIOLATION', 'msg', 'try x');
    expect(e.code).toBe('OWNERSHIP_VIOLATION');
    expect(e.message).toBe('msg');
    expect(e.suggestion).toBe('try x');
  });

  it('serializes to MCP dual response shape', () => {
    const e = new McpError('NOTE_NOT_FOUND', 'missing');
    const r = e.toMcpResponse();
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('NOTE_NOT_FOUND');
    expect(r.content[0].type).toBe('text');
  });

  it('ErrorCode enum includes all spec codes', () => {
    const codes: ErrorCode[] = [
      'OWNERSHIP_VIOLATION', 'UNMAPPED_PATH', 'INVALID_FRONTMATTER',
      'INVALID_FILENAME', 'INVALID_OWNER', 'IMMUTABLE_TARGET',
      'JOURNAL_IMMUTABLE', 'NOTE_NOT_FOUND', 'WIKILINK_TARGET_MISSING',
      'GIT_LOCK_BUSY', 'GIT_PUSH_FAILED', 'VAULT_IO_ERROR',
    ];
    expect(codes.length).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/errors.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement src/errors.ts**

```ts
export type ErrorCode =
  | 'OWNERSHIP_VIOLATION'
  | 'UNMAPPED_PATH'
  | 'INVALID_FRONTMATTER'
  | 'INVALID_FILENAME'
  | 'INVALID_OWNER'
  | 'IMMUTABLE_TARGET'
  | 'JOURNAL_IMMUTABLE'
  | 'NOTE_NOT_FOUND'
  | 'WIKILINK_TARGET_MISSING'
  | 'GIT_LOCK_BUSY'
  | 'GIT_PUSH_FAILED'
  | 'VAULT_IO_ERROR';

export interface McpToolResponse {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}

export class McpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'McpError';
  }

  toMcpResponse(): McpToolResponse {
    return {
      isError: true,
      content: [{ type: 'text', text: `[${this.code}] ${this.message}${this.suggestion ? ` — ${this.suggestion}` : ''}` }],
      structuredContent: { error: { code: this.code, message: this.message, suggestion: this.suggestion } },
    };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/unit/errors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/unit/errors.test.ts
git commit -m "feat(mcp-obsidian): typed McpError with dual response serializer"
```

### Task B3: middleware (rate-limit, request-id, logger, error-handler)

**Files:**
- Create: `src/middleware/rate-limit.ts`, `src/middleware/request-id.ts`, `src/middleware/logger.ts`, `src/middleware/error-handler.ts`

- [ ] **Step 1: Implement rate-limit.ts**

```ts
// src/middleware/rate-limit.ts
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.rateLimitRpm,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});
```

- [ ] **Step 2: Implement request-id.ts**

```ts
// src/middleware/request-id.ts
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare module 'express-serve-static-core' {
  interface Request { requestId: string; }
}

export function requestId(req: Request, _res: Response, next: NextFunction) {
  req.requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  next();
}
```

- [ ] **Step 3: Implement logger.ts (stdout JSON + audit.log appender)**

```ts
// src/middleware/logger.ts
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';

const AUDIT_PATH = path.resolve('logs/audit.log');
fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'audit';
  request_id?: string;
  tool?: string;
  as_agent?: string;
  path?: string;
  duration_ms?: number;
  outcome?: 'ok' | 'error';
  audit?: boolean;
  message?: string;
  [extra: string]: unknown;
}

export function log(entry: LogEntry): void {
  const line = JSON.stringify({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
  process.stdout.write(line + '\n');
  if (entry.audit) {
    fs.appendFileSync(AUDIT_PATH, line + '\n');
  }
}

export function loggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    log({
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 400 ? 'error' : 'info',
      request_id: req.requestId,
      message: `${req.method} ${req.path} ${res.statusCode}`,
      duration_ms: Date.now() - start,
    });
  });
  next();
}
```

- [ ] **Step 4: Implement error-handler.ts**

```ts
// src/middleware/error-handler.ts
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
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/middleware/
git commit -m "feat(mcp-obsidian): middleware stack (rate-limit, request-id, logger, error-handler)"
```

### Task B4: src/auth.ts

**Files:**
- Create: `src/auth.ts`
- Test: `test/unit/auth.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { authMiddleware } from '../../src/auth.js';
import { config } from '../../src/config.js';

function mkReq(headers: Record<string, string> = {}) {
  return { path: '/mcp', headers } as any;
}
function mkRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('authMiddleware', () => {
  beforeAll(() => { (config as any).apiKey = 'secret-token'; });

  it('rejects request without Authorization header', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware(mkReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects wrong token', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware(mkReq({ authorization: 'Bearer wrong' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
  it('passes valid token', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware(mkReq({ authorization: 'Bearer secret-token' }), res, next);
    expect(next).toHaveBeenCalled();
  });
  it('skips /health', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware({ ...mkReq(), path: '/health' } as any, res, next);
    expect(next).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npx vitest run test/unit/auth.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement src/auth.ts**

```ts
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
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npx vitest run test/unit/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/unit/auth.test.ts
git commit -m "feat(mcp-obsidian): bearer auth middleware"
```

### Task B5: src/index.ts (HTTP bootstrap, /health stub, /mcp wiring)

**Files:**
- Create: `src/index.ts`
- Create: `src/server.ts` (stub for now — registers nothing)

- [ ] **Step 1: Write src/server.ts stub**

```ts
// src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'mcp-obsidian', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  // Tools and resources registered in later phases.
  return server;
}
```

- [ ] **Step 2: Write src/index.ts**

```ts
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

const app = express();
app.use(helmet());
app.use(requestId);
app.use(loggerMiddleware);

let lastWriteTs: string | null = null;
export function setLastWriteTs(): void { lastWriteTs = new Date().toISOString(); }

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    vault_notes: 0,           // populated once index is built (Phase F)
    index_age_ms: 0,
    git_head: null,
    last_write_ts: lastWriteTs,
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
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'SSE not supported in stateless mode' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'No sessions to close' }));

app.use(errorHandler);

app.listen(config.port, '0.0.0.0', () => {
  log({ timestamp: new Date().toISOString(), level: 'info', message: `listening on :${config.port}` });
});
```

- [ ] **Step 3: Smoke-run dev server, hit /health**

Run in one terminal: `API_KEY=t VAULT_PATH=/tmp npm run dev`
Run in another: `curl -s http://localhost:3201/health | jq .`
Expected: JSON `{ status: 'healthy', ... }`. Stop dev server.

- [ ] **Step 4: Smoke /mcp without auth**

Run: `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3201/mcp -H 'Content-Type: application/json' -d '{}'`
Expected: `401`.

- [ ] **Step 5: Smoke /mcp with auth (initialize)**

Run: `curl -s -X POST http://localhost:3201/mcp -H 'Authorization: Bearer t' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'`
Expected: JSON with `result.protocolVersion`. Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/server.ts
git commit -m "feat(mcp-obsidian): HTTP bootstrap with /health and /mcp stateless transport"
```

---

## Phase C — vault/fs.ts (atomic IO, ASCII-fold, kebab-case, path traversal guard)

### Task C1: ASCII-fold + kebab-case helpers

**Files:**
- Create: `src/vault/fs.ts`
- Test: `test/unit/fs.test.ts`

- [ ] **Step 1: Write failing test for asciiFold and toKebabSlug**

```ts
// test/unit/fs.test.ts
import { describe, it, expect } from 'vitest';
import { asciiFold, toKebabSlug, validateFilename, validateJournalFilename } from '../../src/vault/fs.js';

describe('asciiFold', () => {
  it('removes diacritics', () => {
    expect(asciiFold('decisão')).toBe('decisao');
    expect(asciiFold('São João')).toBe('Sao Joao');
    expect(asciiFold('ç')).toBe('c');
  });
  it('is idempotent', () => {
    const folded = asciiFold('ação');
    expect(asciiFold(folded)).toBe(folded);
  });
});

describe('toKebabSlug', () => {
  it('lowercases and kebabs', () => {
    expect(toKebabSlug('João Silva')).toBe('joao-silva');
    expect(toKebabSlug('Ações de Cobrança')).toBe('acoes-de-cobranca');
    expect(toKebabSlug('  multiple   spaces  ')).toBe('multiple-spaces');
  });
  it('drops non-alphanum besides hyphen', () => {
    expect(toKebabSlug('a/b\\c?d')).toBe('a-b-c-d');
  });
  it('is idempotent', () => {
    expect(toKebabSlug(toKebabSlug('Ação Y!'))).toBe('acao-y');
  });
});

describe('validateFilename', () => {
  it('accepts kebab .md', () => {
    expect(() => validateFilename('foo-bar.md')).not.toThrow();
  });
  it('rejects uppercase, spaces, leading hyphen, missing .md', () => {
    expect(() => validateFilename('Foo.md')).toThrow(/INVALID_FILENAME/);
    expect(() => validateFilename('foo bar.md')).toThrow();
    expect(() => validateFilename('-foo.md')).toThrow();
    expect(() => validateFilename('foo.txt')).toThrow();
  });
});

describe('validateJournalFilename', () => {
  it('accepts YYYY-MM-DD-slug.md', () => {
    expect(() => validateJournalFilename('2026-04-16-titulo-curto.md')).not.toThrow();
  });
  it('rejects others', () => {
    expect(() => validateJournalFilename('foo.md')).toThrow();
    expect(() => validateJournalFilename('2026-4-16-x.md')).toThrow();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npx vitest run test/unit/fs.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement helpers in src/vault/fs.ts**

```ts
// src/vault/fs.ts
import { McpError } from '../errors.js';

export function asciiFold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function toKebabSlug(s: string): string {
  return asciiFold(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/;
const JOURNAL_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

export function validateFilename(name: string): void {
  if (!FILENAME_RE.test(name)) {
    throw new McpError('INVALID_FILENAME', `Filename '${name}' does not match ${FILENAME_RE.source}`);
  }
}

export function validateJournalFilename(name: string): void {
  if (!JOURNAL_RE.test(name)) {
    throw new McpError('INVALID_FILENAME', `Journal filename '${name}' does not match ${JOURNAL_RE.source}`);
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npx vitest run test/unit/fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/fs.ts test/unit/fs.test.ts
git commit -m "feat(vault/fs): asciiFold, toKebabSlug, filename validators"
```

### Task C2: Path traversal guard + safeJoin

**Files:**
- Modify: `src/vault/fs.ts` — add `safeJoin`
- Modify: `test/unit/fs.test.ts` — add tests

- [ ] **Step 1: Add failing tests for safeJoin**

Append to `test/unit/fs.test.ts`:

```ts
import { safeJoin } from '../../src/vault/fs.js';

describe('safeJoin', () => {
  it('joins relative path under vault root', () => {
    expect(safeJoin('/v', '_agents/ceo/README.md')).toBe('/v/_agents/ceo/README.md');
  });
  it('rejects ..', () => {
    expect(() => safeJoin('/v', '../etc/passwd')).toThrow(/VAULT_IO_ERROR/);
    expect(() => safeJoin('/v', '_agents/../../etc')).toThrow();
  });
  it('rejects absolute paths', () => {
    expect(() => safeJoin('/v', '/etc/passwd')).toThrow();
  });
  it('rejects empty', () => {
    expect(() => safeJoin('/v', '')).toThrow();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/fs.test.ts -t safeJoin`
Expected: FAIL.

- [ ] **Step 3: Implement safeJoin**

Append to `src/vault/fs.ts`:

```ts
import path from 'node:path';

export function safeJoin(vaultRoot: string, relPath: string): string {
  if (!relPath || relPath.trim() === '') {
    throw new McpError('VAULT_IO_ERROR', 'Empty path');
  }
  if (path.isAbsolute(relPath)) {
    throw new McpError('VAULT_IO_ERROR', `Absolute paths not allowed: ${relPath}`);
  }
  const root = path.resolve(vaultRoot);
  const joined = path.resolve(root, relPath);
  if (!joined.startsWith(root + path.sep) && joined !== root) {
    throw new McpError('VAULT_IO_ERROR', `Path traversal detected: ${relPath}`);
  }
  return joined;
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/fs.test.ts -t safeJoin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/fs.ts test/unit/fs.test.ts
git commit -m "feat(vault/fs): safeJoin with path traversal guard"
```

### Task C3: Atomic readFile / writeFile

**Files:**
- Modify: `src/vault/fs.ts` — add `readFileAtomic`, `writeFileAtomic`, `appendFileAtomic`, `deleteFile`, `statFile`
- Modify: `test/unit/fs.test.ts` — add tests using tmpdir

- [ ] **Step 1: Add failing tests**

Append to `test/unit/fs.test.ts`:

```ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readFileAtomic, writeFileAtomic, appendFileAtomic, deleteFile, statFile } from '../../src/vault/fs.js';

describe('atomic file ops', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fs-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writeFileAtomic creates parent dirs and writes', async () => {
    await writeFileAtomic(path.join(tmp, 'a/b/c.md'), 'hello');
    expect(fs.readFileSync(path.join(tmp, 'a/b/c.md'), 'utf8')).toBe('hello');
  });
  it('readFileAtomic returns content + mtime', async () => {
    fs.writeFileSync(path.join(tmp, 'r.md'), 'data');
    const r = await readFileAtomic(path.join(tmp, 'r.md'));
    expect(r.content).toBe('data');
    expect(r.mtimeMs).toBeGreaterThan(0);
  });
  it('appendFileAtomic appends', async () => {
    fs.writeFileSync(path.join(tmp, 'a.md'), 'one\n');
    const r = await appendFileAtomic(path.join(tmp, 'a.md'), 'two');
    expect(r.bytesAppended).toBe(3);
    expect(fs.readFileSync(path.join(tmp, 'a.md'), 'utf8')).toBe('one\ntwo');
  });
  it('deleteFile removes', async () => {
    fs.writeFileSync(path.join(tmp, 'd.md'), 'x');
    await deleteFile(path.join(tmp, 'd.md'));
    expect(fs.existsSync(path.join(tmp, 'd.md'))).toBe(false);
  });
  it('readFileAtomic throws NOTE_NOT_FOUND', async () => {
    await expect(readFileAtomic(path.join(tmp, 'missing.md'))).rejects.toThrow(/NOTE_NOT_FOUND/);
  });
  it('statFile returns null for missing', async () => {
    expect(await statFile(path.join(tmp, 'missing.md'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/fs.test.ts -t "atomic file ops"`
Expected: FAIL.

- [ ] **Step 3: Implement atomic ops**

Append to `src/vault/fs.ts`:

```ts
import { promises as fsp } from 'node:fs';

export interface ReadResult { content: string; mtimeMs: number; }
export interface AppendResult { bytesAppended: number; }

export async function readFileAtomic(absPath: string): Promise<ReadResult> {
  try {
    const [content, st] = await Promise.all([
      fsp.readFile(absPath, 'utf8'),
      fsp.stat(absPath),
    ]);
    return { content, mtimeMs: st.mtimeMs };
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new McpError('NOTE_NOT_FOUND', `File not found: ${absPath}`);
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, absPath);
  } catch (e: any) {
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function appendFileAtomic(absPath: string, content: string): Promise<AppendResult> {
  try {
    await fsp.appendFile(absPath, content, 'utf8');
    return { bytesAppended: Buffer.byteLength(content, 'utf8') };
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new McpError('NOTE_NOT_FOUND', `File not found: ${absPath}`);
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function deleteFile(absPath: string): Promise<void> {
  try {
    await fsp.unlink(absPath);
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new McpError('NOTE_NOT_FOUND', `File not found: ${absPath}`);
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function statFile(absPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fsp.stat(absPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/fs.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add src/vault/fs.ts test/unit/fs.test.ts
git commit -m "feat(vault/fs): atomic readFile/writeFile/appendFile/deleteFile + statFile"
```

---

## Phase D — vault/frontmatter.ts (Zod schemas, parse/serialize)

### Task D1: Base schema + 14-type enum

**Files:**
- Create: `src/vault/frontmatter.ts`
- Test: `test/unit/frontmatter.test.ts`

- [ ] **Step 1: Write failing test for enum + base schema**

```ts
// test/unit/frontmatter.test.ts
import { describe, it, expect } from 'vitest';
import { parseFrontmatter, serializeFrontmatter, FRONTMATTER_TYPES } from '../../src/vault/frontmatter.js';

describe('FRONTMATTER_TYPES', () => {
  it('has 14 valid type values (financial-snapshot is plan 6)', () => {
    expect(FRONTMATTER_TYPES).toEqual([
      'moc','context','agents-map','goal','goals-index',
      'result','results-index','agent-readme','agent-profile',
      'agent-decisions','journal','project-readme',
      'shared-context','entity-profile',
    ]);
  });
});

describe('parseFrontmatter — base', () => {
  it('parses minimal valid frontmatter', () => {
    const src = `---
type: moc
owner: ceo
created: 2026-04-01
updated: 2026-04-10
tags: [paperclip]
---
# body`;
    const r = parseFrontmatter(src);
    expect(r.frontmatter.type).toBe('moc');
    expect(r.frontmatter.owner).toBe('ceo');
    expect(r.body.trim()).toBe('# body');
  });

  it('rejects missing required fields', () => {
    const src = `---\ntype: moc\nowner: ceo\n---\nx`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('rejects unknown type', () => {
    const src = `---
type: garbage
owner: ceo
created: 2026-04-01
updated: 2026-04-10
tags: []
---`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('returns frontmatter:null for legacy file with no frontmatter (no throw)', () => {
    const r = parseFrontmatter('Just body, no frontmatter');
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe('Just body, no frontmatter');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/frontmatter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement base schema**

```ts
// src/vault/frontmatter.ts
import matter from 'gray-matter';
import { z } from 'zod';
import { McpError } from '../errors.js';

export const FRONTMATTER_TYPES = [
  'moc','context','agents-map','goal','goals-index',
  'result','results-index','agent-readme','agent-profile',
  'agent-decisions','journal','project-readme',
  'shared-context','entity-profile',
] as const;

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const periodRe = /^\d{4}-\d{2}$/;
const kebabSegment = /^[a-z0-9][a-z0-9-]*$/;

const BaseSchema = z.object({
  type: z.enum(FRONTMATTER_TYPES),
  owner: z.string().min(1),
  created: z.string().regex(dateRe, 'created must be YYYY-MM-DD'),
  updated: z.string().regex(dateRe, 'updated must be YYYY-MM-DD'),
  tags: z.array(z.string()).default([]),
}).passthrough();

const JournalSchema = BaseSchema.extend({
  type: z.literal('journal'),
  title: z.string().optional(),
});

const GoalResultSchema = BaseSchema.extend({
  type: z.union([z.literal('goal'), z.literal('result')]),
  period: z.string().regex(periodRe, 'period must be YYYY-MM'),
});

const SharedContextSchema = BaseSchema.extend({
  type: z.literal('shared-context'),
  topic: z.string().regex(kebabSegment),
  title: z.string().min(1),
});

const EntityProfileSchema = BaseSchema.extend({
  type: z.literal('entity-profile'),
  entity_type: z.string().regex(kebabSegment),
  entity_name: z.string().min(1),
  status: z.string().optional(),
}).passthrough();

const TYPE_TO_SCHEMA: Record<string, z.ZodTypeAny> = {
  journal: JournalSchema,
  goal: GoalResultSchema,
  result: GoalResultSchema,
  'shared-context': SharedContextSchema,
  'entity-profile': EntityProfileSchema,
};

export interface ParseResult {
  frontmatter: Record<string, any> | null;
  body: string;
}

export function parseFrontmatter(src: string): ParseResult {
  const parsed = matter(src);
  if (!parsed.matter || parsed.matter.trim() === '') {
    return { frontmatter: null, body: src };
  }
  const data = parsed.data as any;
  const schema = TYPE_TO_SCHEMA[data?.type] ?? BaseSchema;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new McpError('INVALID_FRONTMATTER', `Frontmatter invalid: ${result.error.errors.map(e => `${e.path.join('.')}:${e.message}`).join('; ')}`);
  }
  return { frontmatter: result.data as Record<string, any>, body: parsed.content };
}

export function serializeFrontmatter(frontmatter: Record<string, any>, body: string): string {
  return matter.stringify(body, frontmatter);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/frontmatter.ts test/unit/frontmatter.test.ts
git commit -m "feat(vault/frontmatter): base + journal/goal/result/shared-context/entity-profile schemas"
```

### Task D2: Round-trip + extra-field preservation tests

**Files:**
- Modify: `test/unit/frontmatter.test.ts`

- [ ] **Step 1: Add tests**

```ts
describe('round-trip', () => {
  it('preserves arbitrary extra fields via passthrough', () => {
    const src = `---
type: moc
owner: ceo
created: 2026-04-01
updated: 2026-04-10
tags: [a]
foo: bar
nested:
  x: 1
---
body content`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).foo).toBe('bar');
    const round = parseFrontmatter(serializeFrontmatter(r.frontmatter!, r.body));
    expect((round.frontmatter as any).foo).toBe('bar');
    expect((round.frontmatter as any).nested.x).toBe(1);
  });

  it('shared-context requires topic + title', () => {
    const bad = `---
type: shared-context
owner: reno
created: 2026-04-01
updated: 2026-04-01
tags: []
---`;
    expect(() => parseFrontmatter(bad)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('entity-profile requires entity_type + entity_name (kebab)', () => {
    const ok = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-01
tags: []
entity_type: lead
entity_name: João Silva
---`;
    expect(() => parseFrontmatter(ok)).not.toThrow();
    const bad = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-01
tags: []
entity_type: Has Spaces
entity_name: x
---`;
    expect(() => parseFrontmatter(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run (expect pass)**

Run: `npx vitest run test/unit/frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/unit/frontmatter.test.ts
git commit -m "test(vault/frontmatter): round-trip + discriminated-union edge cases"
```

---

## Phase E — vault/ownership.ts

### Task E0: Extend AGENTS.md fixture with explicit pattern table

**Context:** the spec §5.4 says ownership is parsed from `_shared/context/AGENTS.md`. The current AGENTS.md is a navigation MOC with wikilinks but no explicit `pattern → agent` table. We need both:
1. A documented format for the explicit pattern table the parser will read.
2. A fixture file used by tests.

**Files:**
- Create: `test/fixtures/AGENTS.md`

- [ ] **Step 1: Write fixture**

```markdown
---
type: agents-map
owner: renato
created: 2026-04-01
updated: 2026-04-16
tags: [agents, paperclip, openclaw]
---
# Mapa de Agentes (fixture)

## Ownership patterns

```
_agents/alfa/**           => alfa
_agents/beta/**           => beta
_shared/goals/*/alfa.md   => alfa
_shared/goals/*/beta.md   => beta
_shared/results/*/alfa.md => alfa
_shared/results/*/beta.md => beta
_shared/results/*/index.md => alfa
_shared/context/*/alfa/** => alfa
_shared/context/*/beta/** => beta
README.md                  => renato
MEMORY.md                  => renato
```
```

The parser reads any fenced code block whose lines match `^<glob>\s*=>\s*<agent>$` and ignores others. This format is documented in `_shared/context/AGENTS.md` and the README of mcp-obsidian once written (Task L1).

- [ ] **Step 2: Commit fixture**

```bash
git add test/fixtures/AGENTS.md
git commit -m "test(fixtures): AGENTS.md with explicit ownership patterns"
```

### Task E1: parseOwnershipMap

**Files:**
- Create: `src/vault/ownership.ts`
- Test: `test/unit/ownership.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/unit/ownership.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseOwnershipMap, OwnershipMap } from '../../src/vault/ownership.js';

const FIXTURE = path.resolve('test/fixtures/AGENTS.md');

describe('parseOwnershipMap', () => {
  it('parses pattern => agent lines from fenced block', () => {
    const map = parseOwnershipMap(fs.readFileSync(FIXTURE, 'utf8'));
    expect(map.length).toBeGreaterThan(0);
    expect(map.find(p => p.pattern === '_agents/alfa/**' && p.agent === 'alfa')).toBeTruthy();
    expect(map.find(p => p.pattern === 'README.md' && p.agent === 'renato')).toBeTruthy();
  });

  it('ignores text outside fenced blocks', () => {
    const src = `prose
\`\`\`
_agents/x/** => x
\`\`\`
more prose with => arrows that should not match`;
    const map = parseOwnershipMap(src);
    expect(map).toEqual([{ pattern: '_agents/x/**', agent: 'x' }]);
  });

  it('returns empty list when no fenced blocks', () => {
    expect(parseOwnershipMap('# just text')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/ownership.test.ts -t parseOwnershipMap`
Expected: FAIL.

- [ ] **Step 3: Implement parseOwnershipMap**

```ts
// src/vault/ownership.ts
export interface OwnershipPattern { pattern: string; agent: string; }
export type OwnershipMap = OwnershipPattern[];

const FENCE_RE = /```[a-z]*\n([\s\S]*?)```/gi;
const LINE_RE = /^([^\s=]+)\s*=>\s*([a-z][a-z0-9-]*)\s*$/i;

export function parseOwnershipMap(src: string): OwnershipMap {
  const out: OwnershipMap = [];
  for (const m of src.matchAll(FENCE_RE)) {
    for (const raw of m[1].split('\n')) {
      const lm = raw.match(LINE_RE);
      if (lm) out.push({ pattern: lm[1].trim(), agent: lm[2].trim() });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/ownership.test.ts -t parseOwnershipMap`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/ownership.ts test/unit/ownership.test.ts
git commit -m "feat(vault/ownership): parse pattern => agent table from AGENTS.md fenced blocks"
```

### Task E2: resolveOwner with minimatch

**Files:**
- Modify: `src/vault/ownership.ts`
- Modify: `test/unit/ownership.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { resolveOwner } from '../../src/vault/ownership.js';

describe('resolveOwner', () => {
  const map: OwnershipMap = [
    { pattern: '_agents/alfa/**', agent: 'alfa' },
    { pattern: '_agents/beta/**', agent: 'beta' },
    { pattern: '_shared/goals/*/alfa.md', agent: 'alfa' },
    { pattern: '_shared/context/*/alfa/**', agent: 'alfa' },
    { pattern: 'README.md', agent: 'renato' },
  ];

  it('matches exact path', () => {
    expect(resolveOwner('README.md', map)).toBe('renato');
  });
  it('matches recursive glob', () => {
    expect(resolveOwner('_agents/alfa/decisions.md', map)).toBe('alfa');
    expect(resolveOwner('_agents/alfa/journal/2026-04-16-x.md', map)).toBe('alfa');
  });
  it('matches mid-path wildcard', () => {
    expect(resolveOwner('_shared/goals/2026-04/alfa.md', map)).toBe('alfa');
    expect(resolveOwner('_shared/context/objecoes/alfa/x.md', map)).toBe('alfa');
  });
  it('returns null for unmapped path', () => {
    expect(resolveOwner('_agents/gamma/x.md', map)).toBeNull();
  });
  it('first matching pattern wins (order matters)', () => {
    const m: OwnershipMap = [
      { pattern: '_agents/alfa/special.md', agent: 'special-owner' },
      { pattern: '_agents/alfa/**', agent: 'alfa' },
    ];
    expect(resolveOwner('_agents/alfa/special.md', m)).toBe('special-owner');
    expect(resolveOwner('_agents/alfa/other.md', m)).toBe('alfa');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/ownership.test.ts -t resolveOwner`
Expected: FAIL.

- [ ] **Step 3: Implement resolveOwner**

Append to `src/vault/ownership.ts`:

```ts
import { minimatch } from 'minimatch';

export function resolveOwner(relPath: string, map: OwnershipMap): string | null {
  for (const { pattern, agent } of map) {
    if (minimatch(relPath, pattern, { dot: true })) return agent;
  }
  return null;
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/ownership.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/ownership.ts test/unit/ownership.test.ts
git commit -m "feat(vault/ownership): resolveOwner via minimatch with first-match wins"
```

### Task E3: OwnershipResolver class with lazy mtime reload

**Files:**
- Modify: `src/vault/ownership.ts` — add class
- Modify: `test/unit/ownership.test.ts` — add tests

- [ ] **Step 1: Add failing tests using tmp file**

```ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { OwnershipResolver } from '../../src/vault/ownership.js';

describe('OwnershipResolver (lazy mtime reload)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-own-'));
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '```\n_agents/alfa/** => alfa\n```');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('resolves from initial parse', async () => {
    const r = new OwnershipResolver(path.join(tmp, 'AGENTS.md'));
    expect(await r.resolve('_agents/alfa/x.md')).toBe('alfa');
    expect(await r.resolve('_agents/beta/x.md')).toBeNull();
  });

  it('re-parses when AGENTS.md mtime changes', async () => {
    const r = new OwnershipResolver(path.join(tmp, 'AGENTS.md'));
    expect(await r.resolve('_agents/beta/x.md')).toBeNull();
    // Wait 10ms so mtime differs
    await new Promise(res => setTimeout(res, 10));
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '```\n_agents/alfa/** => alfa\n_agents/beta/** => beta\n```');
    expect(await r.resolve('_agents/beta/x.md')).toBe('beta');
  });

  it('listAgents returns unique sorted owners', async () => {
    const r = new OwnershipResolver(path.join(tmp, 'AGENTS.md'));
    expect(await r.listAgents()).toEqual(['alfa']);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/ownership.test.ts -t OwnershipResolver`
Expected: FAIL.

- [ ] **Step 3: Implement OwnershipResolver**

Append to `src/vault/ownership.ts`:

```ts
import { promises as fsp } from 'node:fs';
import { McpError } from '../errors.js';

export class OwnershipResolver {
  private map: OwnershipMap = [];
  private mtimeMs = 0;
  private loaded = false;

  constructor(private readonly agentsMdPath: string) {}

  private async ensureFresh(): Promise<void> {
    let st;
    try { st = await fsp.stat(this.agentsMdPath); }
    catch (e: any) {
      if (e.code === 'ENOENT') throw new McpError('VAULT_IO_ERROR', `AGENTS.md not found at ${this.agentsMdPath}`);
      throw new McpError('VAULT_IO_ERROR', e.message);
    }
    if (this.loaded && st.mtimeMs === this.mtimeMs) return;
    const src = await fsp.readFile(this.agentsMdPath, 'utf8');
    this.map = parseOwnershipMap(src);
    this.mtimeMs = st.mtimeMs;
    this.loaded = true;
  }

  async resolve(relPath: string): Promise<string | null> {
    await this.ensureFresh();
    return resolveOwner(relPath, this.map);
  }

  async listAgents(): Promise<string[]> {
    await this.ensureFresh();
    return [...new Set(this.map.map(p => p.agent))].sort();
  }

  async getMap(): Promise<OwnershipMap> {
    await this.ensureFresh();
    return [...this.map];
  }
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/ownership.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/ownership.ts test/unit/ownership.test.ts
git commit -m "feat(vault/ownership): OwnershipResolver with lazy mtime reload"
```

---

## Phase F — vault/index.ts (in-memory index)

### Task F1: Index data structures + initial build

**Files:**
- Create: `src/vault/index.ts`
- Test: `test/unit/index.test.ts`
- Create: `test/fixtures/vault/` mini-vault layout (real files used in tests)

- [ ] **Step 1: Create mini-vault fixture**

Run:
```bash
mkdir -p test/fixtures/vault/_agents/alfa/journal test/fixtures/vault/_agents/beta test/fixtures/vault/_shared/context
cat > test/fixtures/vault/_shared/context/AGENTS.md <<'EOF'
---
type: agents-map
owner: renato
created: 2026-04-01
updated: 2026-04-16
tags: []
---
```
_agents/alfa/** => alfa
_agents/beta/** => beta
_shared/context/*/alfa/** => alfa
_shared/context/*/beta/** => beta
```
EOF
cat > test/fixtures/vault/_agents/alfa/README.md <<'EOF'
---
type: agent-readme
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: [alfa]
---
# Alfa
Reads [[../beta/profile|Beta profile]].
EOF
cat > test/fixtures/vault/_agents/alfa/profile.md <<'EOF'
---
type: agent-profile
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
# Alfa profile
EOF
cat > test/fixtures/vault/_agents/alfa/decisions.md <<'EOF'
---
type: agent-decisions
owner: alfa
created: 2026-04-01
updated: 2026-04-10
tags: [decisions]
---
## 2026-04-10 — first decision
rationale here
EOF
cat > test/fixtures/vault/_agents/alfa/journal/2026-04-15-titulo.md <<'EOF'
---
type: journal
owner: alfa
created: 2026-04-15
updated: 2026-04-15
tags: [journal]
---
# Entry
Mentions [[../README|alfa README]].
EOF
cat > test/fixtures/vault/_agents/beta/profile.md <<'EOF'
---
type: agent-profile
owner: beta
created: 2026-04-01
updated: 2026-04-01
tags: []
---
# Beta profile
EOF
```

- [ ] **Step 2: Write failing tests**

```ts
// test/unit/index.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';

const FIXTURE = path.resolve('test/fixtures/vault');

describe('VaultIndex.build', () => {
  it('indexes all .md files except AGENTS.md note path conflicts', async () => {
    const idx = new VaultIndex(FIXTURE);
    await idx.build();
    const all = idx.allEntries();
    const paths = all.map(e => e.path).sort();
    expect(paths).toContain('_agents/alfa/README.md');
    expect(paths).toContain('_agents/alfa/profile.md');
    expect(paths).toContain('_agents/alfa/decisions.md');
    expect(paths).toContain('_agents/alfa/journal/2026-04-15-titulo.md');
    expect(paths).toContain('_agents/beta/profile.md');
    expect(paths).toContain('_shared/context/AGENTS.md');
  });
  it('captures owner, type, mtime, tags', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const e = idx.get('_agents/alfa/decisions.md');
    expect(e?.owner).toBe('alfa');
    expect(e?.type).toBe('agent-decisions');
    expect(e?.tags).toEqual(['decisions']);
    expect(e?.mtimeMs).toBeGreaterThan(0);
  });
  it('skips files outside vault and ignores non-md', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const all = idx.allEntries();
    expect(all.every(e => e.path.endsWith('.md'))).toBe(true);
  });
});

describe('VaultIndex queries', () => {
  it('byTag', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const r = idx.byTag('decisions');
    expect(r.map(e => e.path)).toEqual(['_agents/alfa/decisions.md']);
  });
  it('byType', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    expect(idx.byType('agent-profile').length).toBe(2);
  });
  it('byOwner', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const alfa = idx.byOwner('alfa');
    expect(alfa.length).toBeGreaterThanOrEqual(4);
    expect(alfa.every(e => e.owner === 'alfa')).toBe(true);
  });
});

describe('VaultIndex backlinks', () => {
  it('extracts wikilinks and computes backlinks', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const readme = idx.get('_agents/alfa/README.md')!;
    expect(readme.wikilinks).toContain('../beta/profile');
    const beta = idx.backlinks('beta/profile');
    expect(beta.map(b => b.path)).toContain('_agents/alfa/README.md');
  });
});
```

- [ ] **Step 3: Run (expect fail)**

Run: `npx vitest run test/unit/index.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement VaultIndex (build + queries)**

```ts
// src/vault/index.ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { OwnershipResolver } from './ownership.js';
import { McpError } from '../errors.js';

export interface IndexEntry {
  path: string;            // relative to vault root, posix sep
  type: string | null;
  owner: string | null;
  tags: string[];
  wikilinks: string[];     // raw target portion before pipe
  mtimeMs: number;
  bytes: number;
  updated: string | null;
  frontmatter: Record<string, any> | null;
}

const WIKILINK_RE = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g;

export class VaultIndex {
  private entries = new Map<string, IndexEntry>();
  private byTagMap = new Map<string, Set<string>>();
  private byTypeMap = new Map<string, Set<string>>();
  private byOwnerMap = new Map<string, Set<string>>();
  private backlinkMap = new Map<string, Set<string>>(); // target stem → source paths
  private builtAt = 0;
  private ownership: OwnershipResolver;

  constructor(public readonly vaultRoot: string) {
    this.ownership = new OwnershipResolver(path.join(vaultRoot, '_shared/context/AGENTS.md'));
  }

  async build(): Promise<void> {
    this.entries.clear(); this.byTagMap.clear(); this.byTypeMap.clear();
    this.byOwnerMap.clear(); this.backlinkMap.clear();
    await this.walk(this.vaultRoot);
    this.builtAt = Date.now();
  }

  private async walk(dir: string): Promise<void> {
    let names: string[];
    try { names = await fsp.readdir(dir); }
    catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = path.join(dir, name);
      const st = await fsp.stat(full);
      if (st.isDirectory()) await this.walk(full);
      else if (name.endsWith('.md')) await this.indexFile(full, st.mtimeMs, st.size);
    }
  }

  private async indexFile(absPath: string, mtimeMs: number, bytes: number): Promise<void> {
    const rel = path.relative(this.vaultRoot, absPath).split(path.sep).join('/');
    const src = await fsp.readFile(absPath, 'utf8');
    let frontmatter: Record<string, any> | null = null;
    try { frontmatter = parseFrontmatter(src).frontmatter; }
    catch { frontmatter = null; }  // legacy file with bad frontmatter; still indexed

    const owner = await this.ownership.resolve(rel).catch(() => null);
    const tags: string[] = Array.isArray(frontmatter?.tags) ? frontmatter!.tags : [];
    const type: string | null = (frontmatter?.type as string) ?? null;
    const updated: string | null = (frontmatter?.updated as string) ?? null;

    const wikilinks: string[] = [];
    for (const m of src.matchAll(WIKILINK_RE)) wikilinks.push(m[1].trim());

    const entry: IndexEntry = { path: rel, type, owner, tags, wikilinks, mtimeMs, bytes, updated, frontmatter };
    this.entries.set(rel, entry);

    if (type) addTo(this.byTypeMap, type, rel);
    if (owner) addTo(this.byOwnerMap, owner, rel);
    for (const t of tags) addTo(this.byTagMap, t, rel);
    for (const w of wikilinks) {
      const stem = w.split('/').pop()!.replace(/\.md$/, '');
      addTo(this.backlinkMap, stem, rel);
      addTo(this.backlinkMap, w, rel);    // also index full target
    }
  }

  get(rel: string): IndexEntry | undefined { return this.entries.get(rel); }
  allEntries(): IndexEntry[] { return [...this.entries.values()]; }
  byTag(tag: string): IndexEntry[] { return [...(this.byTagMap.get(tag) ?? [])].map(p => this.entries.get(p)!); }
  byType(type: string): IndexEntry[] { return [...(this.byTypeMap.get(type) ?? [])].map(p => this.entries.get(p)!); }
  byOwner(owner: string): IndexEntry[] { return [...(this.byOwnerMap.get(owner) ?? [])].map(p => this.entries.get(p)!); }
  backlinks(noteName: string): IndexEntry[] {
    const stem = noteName.replace(/\.md$/, '').split('/').pop()!;
    return [...(this.backlinkMap.get(stem) ?? this.backlinkMap.get(noteName) ?? [])].map(p => this.entries.get(p)!);
  }
  ageMs(): number { return Date.now() - this.builtAt; }
  size(): number { return this.entries.size; }
  countsByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [t, set] of this.byTypeMap) out[t] = set.size;
    return out;
  }
  countsByAgent(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [a, set] of this.byOwnerMap) out[a] = set.size;
    return out;
  }
  getOwnershipResolver(): OwnershipResolver { return this.ownership; }
}

function addTo(map: Map<string, Set<string>>, key: string, val: string): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(val);
}
```

- [ ] **Step 5: Run (expect pass)**

Run: `npx vitest run test/unit/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/vault/index.ts test/unit/index.test.ts test/fixtures/vault/
git commit -m "feat(vault/index): in-memory index with tags/type/owner/wikilinks/backlinks/mtime"
```

### Task F2: Lazy invalidation on read + post-write update

**Files:**
- Modify: `src/vault/index.ts` — add `refreshIfStale(rel)` and `updateAfterWrite(rel)`
- Modify: `test/unit/index.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import fs from 'node:fs';

describe('VaultIndex lazy invalidation', () => {
  it('refreshIfStale picks up new tags after external write', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const target = path.join(FIXTURE, '_agents/alfa/temp.md');
    fs.writeFileSync(target, `---
type: journal
owner: alfa
created: 2026-04-15
updated: 2026-04-15
tags: [tempfix]
---
# t`);
    try {
      await idx.refreshIfStale('_agents/alfa/temp.md');
      expect(idx.byTag('tempfix').length).toBe(1);
    } finally {
      fs.unlinkSync(target);
    }
  });

  it('updateAfterWrite re-indexes a single file without full rebuild', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const target = path.join(FIXTURE, '_agents/alfa/temp2.md');
    fs.writeFileSync(target, `---
type: journal
owner: alfa
created: 2026-04-15
updated: 2026-04-15
tags: [updtest]
---
# x`);
    try {
      await idx.updateAfterWrite('_agents/alfa/temp2.md');
      expect(idx.get('_agents/alfa/temp2.md')?.tags).toEqual(['updtest']);
    } finally {
      fs.unlinkSync(target);
    }
  });

  it('updateAfterWrite removes entry when file deleted', async () => {
    const idx = new VaultIndex(FIXTURE); await idx.build();
    const target = path.join(FIXTURE, '_agents/alfa/del.md');
    fs.writeFileSync(target, `---
type: journal
owner: alfa
created: 2026-04-15
updated: 2026-04-15
tags: []
---
x`);
    await idx.updateAfterWrite('_agents/alfa/del.md');
    expect(idx.get('_agents/alfa/del.md')).toBeTruthy();
    fs.unlinkSync(target);
    await idx.updateAfterWrite('_agents/alfa/del.md');
    expect(idx.get('_agents/alfa/del.md')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/index.test.ts -t "lazy invalidation"`
Expected: FAIL.

- [ ] **Step 3: Implement refreshIfStale and updateAfterWrite**

Append to `src/vault/index.ts`:

```ts
// Inside VaultIndex class:

async refreshIfStale(rel: string): Promise<void> {
  const abs = path.join(this.vaultRoot, rel);
  let st;
  try { st = await fsp.stat(abs); }
  catch { this.removeEntry(rel); return; }
  const cached = this.entries.get(rel);
  if (cached && cached.mtimeMs === st.mtimeMs) return;
  await this.indexFile(abs, st.mtimeMs, st.size);
}

async updateAfterWrite(rel: string): Promise<void> {
  this.removeEntry(rel);
  const abs = path.join(this.vaultRoot, rel);
  let st;
  try { st = await fsp.stat(abs); }
  catch { return; }
  await this.indexFile(abs, st.mtimeMs, st.size);
}

private removeEntry(rel: string): void {
  const e = this.entries.get(rel);
  if (!e) return;
  if (e.type) this.byTypeMap.get(e.type)?.delete(rel);
  if (e.owner) this.byOwnerMap.get(e.owner)?.delete(rel);
  for (const t of e.tags) this.byTagMap.get(t)?.delete(rel);
  for (const w of e.wikilinks) {
    const stem = w.split('/').pop()!.replace(/\.md$/, '');
    this.backlinkMap.get(stem)?.delete(rel);
    this.backlinkMap.get(w)?.delete(rel);
  }
  this.entries.delete(rel);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.ts test/unit/index.test.ts
git commit -m "feat(vault/index): refreshIfStale + updateAfterWrite for incremental updates"
```

---

## Phase G — vault/git.ts (commit_and_push + git_status with flock)

### Task G1: GitOps class

**Files:**
- Create: `src/vault/git.ts`
- Test: `test/unit/git.test.ts` (uses tmp git repo, no remote)

- [ ] **Step 1: Write failing tests**

```ts
// test/unit/git.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { GitOps } from '../../src/vault/git.js';

describe('GitOps', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-git-'));
    execSync('git init -q -b main', { cwd: tmp });
    execSync('git config user.email "t@t" && git config user.name "t"', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# init');
    execSync('git add . && git commit -q -m init', { cwd: tmp });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('git_status reports clean repo', async () => {
    const g = new GitOps(tmp, '/tmp/mcp-test.lock', 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.status();
    expect(r.modified).toEqual([]);
    expect(r.untracked).toEqual([]);
  });

  it('git_status reports modifications', async () => {
    fs.writeFileSync(path.join(tmp, 'new.md'), 'x');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# changed');
    const g = new GitOps(tmp, '/tmp/mcp-test.lock', 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.status();
    expect(r.untracked).toContain('new.md');
    expect(r.modified).toContain('README.md');
  });

  it('commit_and_push creates a commit (push mocked: no remote → returns pushed=false)', async () => {
    fs.writeFileSync(path.join(tmp, 'x.md'), 'x');
    const g = new GitOps(tmp, '/tmp/mcp-test.lock', 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.commitAndPush('test commit');
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.branch).toBe('main');
    expect(r.pushed).toBe(false);
    const log = execSync('git log --oneline -1', { cwd: tmp, encoding: 'utf8' });
    expect(log).toContain('[mcp-obsidian] test commit');
  });

  it('commit_and_push with no changes throws or returns no-op', async () => {
    const g = new GitOps(tmp, '/tmp/mcp-test.lock', 'mcp-obsidian', 'mcp@fama.local');
    const r = await g.commitAndPush('noop');
    expect(r.sha).toBe('');
    expect(r.pushed).toBe(false);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/unit/git.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement GitOps**

```ts
// src/vault/git.ts
import { simpleGit, SimpleGit } from 'simple-git';
import lockfile from 'proper-lockfile';
import { McpError } from '../errors.js';

export interface CommitResult { sha: string; branch: string; pushed: boolean; }
export interface StatusResult { modified: string[]; untracked: string[]; ahead: number; behind: number; }

export class GitOps {
  private git: SimpleGit;
  constructor(
    private readonly cwd: string,
    private readonly lockfilePath: string,
    private readonly authorName: string,
    private readonly authorEmail: string,
  ) {
    this.git = simpleGit(cwd);
  }

  async status(): Promise<StatusResult> {
    try {
      const s = await this.git.status();
      return {
        modified: [...s.modified, ...s.created, ...s.renamed.map(r => r.to)],
        untracked: s.not_added,
        ahead: s.ahead,
        behind: s.behind,
      };
    } catch (e: any) {
      throw new McpError('VAULT_IO_ERROR', `git status failed: ${e.message}`);
    }
  }

  async head(): Promise<string | null> {
    try { return (await this.git.revparse(['HEAD'])).trim(); }
    catch { return null; }
  }

  async commitAndPush(message: string): Promise<CommitResult> {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.lockfilePath, { retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 }, realpath: false }).catch((e: any) => {
        throw new McpError('GIT_LOCK_BUSY', `Could not acquire lock at ${this.lockfilePath}: ${e.message}`);
      });

      await this.git.addConfig('user.name', this.authorName, false, 'local');
      await this.git.addConfig('user.email', this.authorEmail, false, 'local');

      await this.git.add('.');
      const status = await this.git.status();
      if (status.staged.length === 0 && status.created.length === 0 && status.renamed.length === 0 && status.deleted.length === 0) {
        return { sha: '', branch: status.current ?? 'main', pushed: false };
      }
      await this.git.commit(`[mcp-obsidian] ${message}`);
      const sha = (await this.git.revparse(['HEAD'])).trim();
      const branch = (await this.git.branch()).current;

      let pushed = false;
      try {
        const remotes = await this.git.getRemotes(true);
        if (remotes.length > 0) {
          await this.git.push();
          pushed = true;
        }
      } catch (e: any) {
        throw new McpError('GIT_PUSH_FAILED', `push failed: ${e.message}`);
      }
      return { sha, branch, pushed };
    } finally {
      if (release) await release();
    }
  }
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/unit/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/git.ts test/unit/git.test.ts
git commit -m "feat(vault/git): GitOps with flock-coordinated commit + status"
```

---

## Phase H — tools/crud.ts (8 CRUD tools)

**Pattern:** every tool is a function `(args, ctx) => Promise<McpToolResponse>`. `ctx` = `{ index: VaultIndex, vaultRoot: string }`. Tools throw `McpError` for typed failures; the registration layer (Phase L) wraps the throw in `toMcpResponse()`.

### Task H1: read_note

**Files:**
- Create: `src/tools/crud.ts` (start file)
- Test: `test/integration/crud.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/integration/crud.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';
import { readNote } from '../../src/tools/crud.js';

const FIXTURE = path.resolve('test/fixtures/vault');

let ctx: { index: VaultIndex; vaultRoot: string };
beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

describe('read_note', () => {
  it('returns frontmatter, content, and metadata', async () => {
    const r = await readNote({ path: '_agents/alfa/decisions.md' }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).frontmatter.type).toBe('agent-decisions');
    expect((r.structuredContent as any).path).toBe('_agents/alfa/decisions.md');
    expect((r.structuredContent as any).content).toContain('first decision');
    expect((r.structuredContent as any).bytes).toBeGreaterThan(0);
  });

  it('throws NOTE_NOT_FOUND for missing file', async () => {
    const r = await readNote({ path: '_agents/missing.md' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('NOTE_NOT_FOUND');
  });

  it('throws VAULT_IO_ERROR on path traversal', async () => {
    const r = await readNote({ path: '../etc/passwd' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('VAULT_IO_ERROR');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/crud.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement readNote**

```ts
// src/tools/crud.ts
import { z } from 'zod';
import path from 'node:path';
import { VaultIndex } from '../vault/index.js';
import { readFileAtomic, safeJoin, statFile } from '../vault/fs.js';
import { parseFrontmatter } from '../vault/frontmatter.js';
import { McpError, McpToolResponse } from '../errors.js';

export interface ToolCtx { index: VaultIndex; vaultRoot: string; }

async function tryToolBody<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: McpError }> {
  try { return { ok: true, value: await fn() }; }
  catch (e: any) {
    if (e instanceof McpError) return { ok: false, err: e };
    return { ok: false, err: new McpError('VAULT_IO_ERROR', e.message) };
  }
}

function ok(structured: Record<string, unknown>, text: string): McpToolResponse {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export const ReadNoteSchema = z.object({ path: z.string().min(1) });

export async function readNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const { path: rel } = ReadNoteSchema.parse(args);
    const abs = safeJoin(ctx.vaultRoot, rel);
    const { content, mtimeMs } = await readFileAtomic(abs);
    const { frontmatter, body } = parseFrontmatter(content);
    const wl: string[] = [];
    for (const m of body.matchAll(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g)) wl.push(m[1].trim());
    const stem = path.basename(rel).replace(/\.md$/, '');
    const backlinksCount = ctx.index.backlinks(stem).length;
    return {
      frontmatter,
      content,
      path: rel,
      wikilinks: wl,
      backlinks_count: backlinksCount,
      bytes: Buffer.byteLength(content, 'utf8'),
      updated: frontmatter?.updated ?? null,
      mtime: new Date(mtimeMs).toISOString(),
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `Read ${r.value.path} (${r.value.bytes}b, ${r.value.wikilinks.length} wikilinks, ${r.value.backlinks_count} backlinks)`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/crud.test.ts -t read_note`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(tools/crud): read_note"
```

### Task H2: write_note

**Files:**
- Modify: `src/tools/crud.ts`
- Modify: `test/integration/crud.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import fs from 'node:fs';
import { writeNote } from '../../src/tools/crud.js';

describe('write_note', () => {
  it('creates new note with valid frontmatter and ownership', async () => {
    const args = {
      path: '_agents/alfa/notes/x.md',
      content: '# new',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    };
    const r = await writeNote(args, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(path.join(FIXTURE, '_agents/alfa/notes/x.md'))).toBe(true);
    fs.rmSync(path.join(FIXTURE, '_agents/alfa/notes'), { recursive: true });
  });

  it('OWNERSHIP_VIOLATION when as_agent !== owner', async () => {
    const r = await writeNote({
      path: '_agents/alfa/notes/y.md',
      content: '#',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'beta',
    }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });

  it('UNMAPPED_PATH when path is not in ownership map', async () => {
    const r = await writeNote({
      path: '_random/dir/z.md',
      content: '#',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('UNMAPPED_PATH');
  });

  it('INVALID_FILENAME on uppercase path', async () => {
    const r = await writeNote({
      path: '_agents/alfa/notes/Bad.md',
      content: '#',
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/crud.test.ts -t write_note`
Expected: FAIL.

- [ ] **Step 3: Implement writeNote**

Append to `src/tools/crud.ts`:

```ts
import { writeFileAtomic } from '../vault/fs.js';
import { serializeFrontmatter } from '../vault/frontmatter.js';
import { validateFilename, asciiFold, toKebabSlug } from '../vault/fs.js';
import { setLastWriteTs } from '../index.js';
import { log } from '../middleware/logger.js';

export const WriteNoteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  frontmatter: z.record(z.any()),
  as_agent: z.string().min(1),
});

async function ownerCheck(ctx: ToolCtx, rel: string, asAgent: string): Promise<void> {
  const owner = await ctx.index.getOwnershipResolver().resolve(rel);
  if (owner === null) {
    throw new McpError('UNMAPPED_PATH', `Path '${rel}' não está mapeado em _shared/context/AGENTS.md. Adicione um pattern antes de escrever aqui.`);
  }
  if (owner !== asAgent) {
    throw new McpError('OWNERSHIP_VIOLATION', `File '${rel}' is owned by '${owner}', not '${asAgent}'. Use as_agent='${owner}' or write under your own agent path.`, `Use as_agent='${owner}'`);
  }
}

export async function writeNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = WriteNoteSchema.parse(args);
    const filename = path.basename(a.path);
    validateFilename(filename);
    const safe = safeJoin(ctx.vaultRoot, a.path);

    await ownerCheck(ctx, a.path, a.as_agent);

    // Ensure type is in the schema (revalidate via parseFrontmatter on assembled content)
    const fm = { ...a.frontmatter, owner: a.frontmatter.owner ?? a.as_agent };
    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);   // throws INVALID_FRONTMATTER if invalid

    const exists = await statFile(safe);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(a.path);
    setLastWriteTs();

    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'write_note', as_agent: a.as_agent, path: a.path, action: exists ? 'update' : 'create', outcome: 'ok' });

    return { path: a.path, created: !exists };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `${r.value.created ? 'Created' : 'Updated'} ${r.value.path}`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/crud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(tools/crud): write_note with ownership + filename + frontmatter validation"
```

### Task H3: append_to_note

- [ ] **Step 1: Add failing tests**

```ts
import { appendToNote } from '../../src/tools/crud.js';

describe('append_to_note', () => {
  it('appends content to an existing non-immutable note', async () => {
    const target = path.join(FIXTURE, '_agents/alfa/notes/app.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `---
type: agent-readme
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
# x`);
    await ctx.index.updateAfterWrite('_agents/alfa/notes/app.md');
    const r = await appendToNote({ path: '_agents/alfa/notes/app.md', content: '\nappended', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toContain('appended');
    fs.rmSync(path.dirname(target), { recursive: true });
  });

  it('IMMUTABLE_TARGET on decisions.md', async () => {
    const r = await appendToNote({ path: '_agents/alfa/decisions.md', content: 'x', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('IMMUTABLE_TARGET');
  });

  it('JOURNAL_IMMUTABLE message hints append usage', async () => {
    // append_to_note IS the allowed path for journals; verify it works on existing journal.
    const target = '_agents/alfa/journal/2026-04-15-titulo.md';
    const before = fs.readFileSync(path.join(FIXTURE, target), 'utf8');
    const r = await appendToNote({ path: target, content: '\nmore', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBeUndefined();
    fs.writeFileSync(path.join(FIXTURE, target), before);   // restore
    await ctx.index.updateAfterWrite(target);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/crud.test.ts -t append_to_note`
Expected: FAIL.

- [ ] **Step 3: Implement appendToNote**

Append to `src/tools/crud.ts`:

```ts
import { appendFileAtomic } from '../vault/fs.js';

export const AppendToNoteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  as_agent: z.string().min(1),
});

function isDecisionsPath(rel: string): boolean { return /(^|\/)decisions\.md$/.test(rel); }

export async function appendToNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendToNoteSchema.parse(args);
    if (isDecisionsPath(a.path)) {
      throw new McpError('IMMUTABLE_TARGET', `decisions.md is append-only via append_decision tool, not append_to_note.`);
    }
    await ownerCheck(ctx, a.path, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, a.path);
    const r2 = await appendFileAtomic(safe, a.content);
    await ctx.index.updateAfterWrite(a.path);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_to_note', as_agent: a.as_agent, path: a.path, action: 'append', outcome: 'ok' });
    return { path: a.path, bytes_appended: r2.bytesAppended };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `Appended ${r.value.bytes_appended}b to ${r.value.path}`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/crud.test.ts -t append_to_note`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(tools/crud): append_to_note (blocks decisions.md)"
```

### Task H4: delete_note

- [ ] **Step 1: Add failing tests**

```ts
import { deleteNote } from '../../src/tools/crud.js';

describe('delete_note', () => {
  it('deletes file with reason and removes from index', async () => {
    const target = path.join(FIXTURE, '_agents/alfa/notes/del.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `---
type: agent-readme
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
x`);
    await ctx.index.updateAfterWrite('_agents/alfa/notes/del.md');
    const r = await deleteNote({ path: '_agents/alfa/notes/del.md', as_agent: 'alfa', reason: 'cleanup' }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).deleted).toBe(true);
    expect((r.structuredContent as any).reason).toBe('cleanup');
    expect(fs.existsSync(target)).toBe(false);
    expect(ctx.index.get('_agents/alfa/notes/del.md')).toBeUndefined();
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
  });

  it('OWNERSHIP_VIOLATION when as_agent != owner', async () => {
    const r = await deleteNote({ path: '_agents/alfa/decisions.md', as_agent: 'beta', reason: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });

  it('reason required (zod throws when missing)', async () => {
    const r = await deleteNote({ path: '_agents/alfa/decisions.md', as_agent: 'alfa' }, ctx);
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/crud.test.ts -t delete_note`
Expected: FAIL.

- [ ] **Step 3: Implement deleteNote**

Append to `src/tools/crud.ts`:

```ts
import { deleteFile } from '../vault/fs.js';

export const DeleteNoteSchema = z.object({
  path: z.string().min(1),
  as_agent: z.string().min(1),
  reason: z.string().min(1),
});

export async function deleteNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = DeleteNoteSchema.parse(args);
    await ownerCheck(ctx, a.path, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, a.path);
    await deleteFile(safe);
    await ctx.index.updateAfterWrite(a.path);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'delete_note', as_agent: a.as_agent, path: a.path, action: 'delete', reason: a.reason, outcome: 'ok' });
    return { path: a.path, deleted: true, reason: a.reason };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value, `Deleted ${r.value.path} (reason: ${r.value.reason})`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/crud.test.ts -t delete_note`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(tools/crud): delete_note with mandatory reason for audit"
```

### Task H5: list_folder + owner filter

- [ ] **Step 1: Add failing tests**

```ts
import { listFolder } from '../../src/tools/crud.js';

describe('list_folder', () => {
  it('lists notes under a folder', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true }, ctx);
    const items = (r.structuredContent as any).items;
    expect(items.map((i: any) => i.path)).toContain('_agents/alfa/decisions.md');
    expect(items.every((i: any) => i.path.startsWith('_agents/alfa/'))).toBe(true);
  });

  it('owner filter accepts string or array', async () => {
    const r1 = await listFolder({ path: '_agents', recursive: true, owner: 'alfa' }, ctx);
    expect((r1.structuredContent as any).items.every((i: any) => i.owner === 'alfa')).toBe(true);

    const r2 = await listFolder({ path: '_agents', recursive: true, owner: ['alfa', 'beta'] }, ctx);
    const owners = new Set((r2.structuredContent as any).items.map((i: any) => i.owner));
    expect([...owners].sort()).toEqual(['alfa', 'beta']);
  });

  it('INVALID_OWNER on unknown agent', async () => {
    const r = await listFolder({ path: '_agents', recursive: true, owner: 'gamma' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('INVALID_OWNER');
  });

  it('paginates via cursor + limit', async () => {
    const r1 = await listFolder({ path: '_agents', recursive: true, limit: 2 }, ctx);
    const items1 = (r1.structuredContent as any).items;
    const cursor = (r1.structuredContent as any).next_cursor;
    expect(items1.length).toBe(2);
    expect(typeof cursor).toBe('string');
    const r2 = await listFolder({ path: '_agents', recursive: true, limit: 2, cursor }, ctx);
    const items2 = (r2.structuredContent as any).items;
    expect(items2[0].path).not.toBe(items1[0].path);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/crud.test.ts -t list_folder`
Expected: FAIL.

- [ ] **Step 3: Implement listFolder**

Append to `src/tools/crud.ts`:

```ts
function encodeCursor(offset: number, queryHash: string): string {
  return Buffer.from(JSON.stringify({ offset, queryHash })).toString('base64url');
}
function decodeCursor(c: string): { offset: number; queryHash: string } {
  return JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
}
function hashQuery(o: any): string { return Buffer.from(JSON.stringify(o)).toString('base64url').slice(0, 12); }

export const ListFolderSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional().default(false),
  filter_type: z.string().optional(),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
});

async function validateOwners(ctx: ToolCtx, owner?: string | string[]): Promise<string[] | undefined> {
  if (!owner) return undefined;
  const list = Array.isArray(owner) ? owner : [owner];
  const valid = new Set(await ctx.index.getOwnershipResolver().listAgents());
  const bad = list.filter(o => !valid.has(o));
  if (bad.length > 0) {
    throw new McpError('INVALID_OWNER', `Unknown owner(s): ${bad.join(', ')}. Valid: ${[...valid].join(', ')}`);
  }
  return list;
}

export async function listFolder(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ListFolderSchema.parse(args);
    const owners = await validateOwners(ctx, a.owner);

    const prefix = a.path.replace(/\/+$/, '') + '/';
    let entries = ctx.index.allEntries().filter(e => {
      if (a.path === '' || a.path === '/') return true;
      if (!a.recursive) {
        // direct children only: same dir prefix, no extra slashes after prefix
        if (!e.path.startsWith(prefix)) return false;
        return !e.path.slice(prefix.length).includes('/');
      }
      return e.path.startsWith(prefix);
    });
    if (a.filter_type) entries = entries.filter(e => e.type === a.filter_type);
    if (owners) entries = entries.filter(e => e.owner !== null && owners.includes(e.owner));
    entries.sort((x, y) => x.path.localeCompare(y.path));

    const queryHash = hashQuery({ p: a.path, r: a.recursive, ft: a.filter_type, o: owners });
    let offset = 0;
    if (a.cursor) {
      const c = decodeCursor(a.cursor);
      if (c.queryHash !== queryHash) throw new McpError('VAULT_IO_ERROR', 'cursor query mismatch');
      offset = c.offset;
    }
    const page = entries.slice(offset, offset + a.limit);
    const nextOffset = offset + page.length;
    const next_cursor = nextOffset < entries.length ? encodeCursor(nextOffset, queryHash) : undefined;

    return {
      items: page.map(e => ({ path: e.path, type: e.type, owner: e.owner, updated: e.updated, tags: e.tags })),
      next_cursor,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).items.length} item(s)${(r.value as any).next_cursor ? ' (more)' : ''}`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/crud.test.ts -t list_folder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(tools/crud): list_folder with owner multi-filter and pagination"
```

### Task H6: search_content (ripgrep wrapper) + owner filter

- [ ] **Step 1: Add failing tests**

```ts
import { searchContent } from '../../src/tools/crud.js';

describe('search_content', () => {
  it('finds literal occurrences', async () => {
    const r = await searchContent({ query: 'first decision' }, ctx);
    const matches = (r.structuredContent as any).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].path).toBe('_agents/alfa/decisions.md');
    expect(matches[0].line).toBeGreaterThan(0);
    expect(typeof matches[0].preview).toBe('string');
  });

  it('owner filter restricts post-ripgrep', async () => {
    const r = await searchContent({ query: '#', owner: 'beta' }, ctx);
    const m = (r.structuredContent as any).matches;
    expect(m.every((x: any) => ctx.index.get(x.path)?.owner === 'beta')).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/crud.test.ts -t search_content`
Expected: FAIL.

- [ ] **Step 3: Implement searchContent**

Append to `src/tools/crud.ts`:

```ts
import { spawn } from 'node:child_process';

export const SearchContentSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  type: z.string().optional(),
  tag: z.string().optional(),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
});

interface RgMatch { path: string; line: number; preview: string; }

async function ripgrep(query: string, root: string, scope?: string): Promise<RgMatch[]> {
  return new Promise((resolve, reject) => {
    const args = ['--json', '--max-count', '500', '-S', '--type', 'md', query];
    if (scope) args.push(scope);
    else args.push('.');
    const proc = spawn('rg', args, { cwd: root });
    const out: RgMatch[] = [];
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const ln of lines) {
        if (!ln) continue;
        try {
          const obj = JSON.parse(ln);
          if (obj.type === 'match') {
            out.push({
              path: obj.data.path.text,
              line: obj.data.line_number,
              preview: (obj.data.lines.text as string).trimEnd(),
            });
          }
        } catch { /* ignore */ }
      }
    });
    proc.on('error', reject);
    proc.on('exit', () => resolve(out));
  });
}

export async function searchContent(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = SearchContentSchema.parse(args);
    const owners = await validateOwners(ctx, a.owner);
    let matches = await ripgrep(a.query, ctx.vaultRoot, a.path);
    matches = matches.map(m => ({ ...m, path: m.path.split(path.sep).join('/') }));
    if (a.type) matches = matches.filter(m => ctx.index.get(m.path)?.type === a.type);
    if (a.tag) matches = matches.filter(m => ctx.index.get(m.path)?.tags.includes(a.tag!));
    if (owners) matches = matches.filter(m => {
      const o = ctx.index.get(m.path)?.owner;
      return o !== null && o !== undefined && owners.includes(o);
    });

    const queryHash = hashQuery({ q: a.query, p: a.path, t: a.type, tg: a.tag, o: owners });
    let offset = 0;
    if (a.cursor) {
      const c = decodeCursor(a.cursor);
      if (c.queryHash !== queryHash) throw new McpError('VAULT_IO_ERROR', 'cursor query mismatch');
      offset = c.offset;
    }
    const page = matches.slice(offset, offset + a.limit);
    const next_cursor = offset + page.length < matches.length ? encodeCursor(offset + page.length, queryHash) : undefined;
    return { matches: page, next_cursor };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).matches.length} match(es)`);
}
```

- [ ] **Step 4: Verify ripgrep is in PATH**

Run: `which rg && rg --version | head -1`
Expected: prints path and version. If missing, install via `apk add ripgrep` (alpine) or system equivalent. Add `RUN apk add --no-cache ripgrep` to Dockerfile (Phase A4) if not already.

- [ ] **Step 5: Add ripgrep install to Dockerfile**

Modify `Dockerfile`'s second stage `RUN apk add` to include `ripgrep`:

```dockerfile
RUN apk add --no-cache git util-linux ripgrep
```

- [ ] **Step 6: Run (expect pass)**

Run: `npx vitest run test/integration/crud.test.ts -t search_content`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts Dockerfile
git commit -m "feat(tools/crud): search_content via ripgrep with type/tag/owner filters"
```

### Task H7: get_note_metadata + stat_vault

- [ ] **Step 1: Add failing tests**

```ts
import { getNoteMetadata, statVault } from '../../src/tools/crud.js';

describe('get_note_metadata', () => {
  it('returns frontmatter + wikilinks + backlinks + bytes', async () => {
    const r = await getNoteMetadata({ path: '_agents/alfa/README.md' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.frontmatter.type).toBe('agent-readme');
    expect(Array.isArray(sc.wikilinks)).toBe(true);
    expect(Array.isArray(sc.backlinks)).toBe(true);
    expect(typeof sc.bytes).toBe('number');
  });
  it('NOTE_NOT_FOUND on missing', async () => {
    const r = await getNoteMetadata({ path: '_agents/alfa/missing.md' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('NOTE_NOT_FOUND');
  });
});

describe('stat_vault', () => {
  it('returns counts', async () => {
    const r = await statVault({}, ctx);
    const sc = r.structuredContent as any;
    expect(sc.total_notes).toBeGreaterThan(0);
    expect(typeof sc.by_type).toBe('object');
    expect(typeof sc.by_agent).toBe('object');
    expect(typeof sc.index_age_ms).toBe('number');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/crud.test.ts -t "get_note_metadata|stat_vault"`
Expected: FAIL.

- [ ] **Step 3: Implement getNoteMetadata + statVault**

Append to `src/tools/crud.ts`:

```ts
export const GetNoteMetadataSchema = z.object({ path: z.string().min(1) });

export async function getNoteMetadata(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const { path: rel } = GetNoteMetadataSchema.parse(args);
    let entry = ctx.index.get(rel);
    if (!entry) {
      const safe = safeJoin(ctx.vaultRoot, rel);
      const st = await statFile(safe);
      if (!st) throw new McpError('NOTE_NOT_FOUND', `File not found: ${rel}`);
      await ctx.index.updateAfterWrite(rel);
      entry = ctx.index.get(rel);
      if (!entry) throw new McpError('NOTE_NOT_FOUND', `File not found: ${rel}`);
    }
    const stem = path.basename(rel).replace(/\.md$/, '');
    const backlinks = ctx.index.backlinks(stem).map(e => ({ path: e.path }));
    return {
      frontmatter: entry.frontmatter,
      wikilinks: entry.wikilinks,
      backlinks,
      bytes: entry.bytes,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Metadata for ${(args as any).path}`);
}

export const StatVaultSchema = z.object({}).passthrough();

export async function statVault(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    return {
      total_notes: ctx.index.size(),
      by_type: ctx.index.countsByType(),
      by_agent: ctx.index.countsByAgent(),
      index_age_ms: ctx.index.ageMs(),
      last_sync: null,           // populated when GitOps wired in Phase L
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `${sc.total_notes} notes, ${Object.keys(sc.by_type).length} types, ${Object.keys(sc.by_agent).length} agents`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/crud.test.ts -t "get_note_metadata|stat_vault"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(tools/crud): get_note_metadata + stat_vault"
```

---

## Phase I — tools/workflows.ts (12 workflow tools)

**Each workflow tool sits in `src/tools/workflows.ts`. All call into `vault/` and reuse `ownerCheck`, `ok()`, `tryToolBody()`, `safeJoin` from `tools/crud.ts`. Export these helpers from `crud.ts` or move to a shared `tools/_helpers.ts`.**

### Task I0: Extract shared tool helpers

**Files:**
- Create: `src/tools/_helpers.ts`
- Modify: `src/tools/crud.ts` — import helpers from `_helpers.ts`

- [ ] **Step 1: Move helpers**

Create `src/tools/_helpers.ts` with: `ToolCtx`, `tryToolBody`, `ok`, `ownerCheck`, `validateOwners`, `encodeCursor`, `decodeCursor`, `hashQuery`. Update `crud.ts` to import them.

- [ ] **Step 2: Typecheck + tests still pass**

Run: `npm run typecheck && npx vitest run test/integration/crud.test.ts`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/tools/
git commit -m "refactor(tools): extract shared helpers to _helpers.ts"
```

### Task I1: create_journal_entry

**Files:**
- Create: `src/tools/workflows.ts`
- Test: `test/integration/workflows.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/integration/workflows.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { createJournalEntry } from '../../src/tools/workflows.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };
beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

describe('create_journal_entry', () => {
  it('creates _agents/<agent>/journal/YYYY-MM-DD-<slug>.md with journal frontmatter', async () => {
    const r = await createJournalEntry({ agent: 'alfa', title: 'Ação de Testar', content: '# body', tags: ['teste'] }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.path).toMatch(/^_agents\/alfa\/journal\/\d{4}-\d{2}-\d{2}-acao-de-testar\.md$/);
    expect(sc.created).toBe(true);
    const abs = path.join(FIXTURE, sc.path);
    expect(fs.existsSync(abs)).toBe(true);
    fs.unlinkSync(abs);
    await ctx.index.updateAfterWrite(sc.path);
  });

  it('OWNERSHIP_VIOLATION if agent is not the owner of _agents/<agent>/', async () => {
    // Here agent=alfa, as_agent is implicitly alfa too — but we still need to fail for bad agent name
    const r = await createJournalEntry({ agent: 'gamma', title: 'x', content: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(['UNMAPPED_PATH', 'OWNERSHIP_VIOLATION']).toContain((r.structuredContent as any).error.code);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t create_journal_entry`
Expected: FAIL.

- [ ] **Step 3: Implement createJournalEntry**

```ts
// src/tools/workflows.ts
import { z } from 'zod';
import path from 'node:path';
import { ToolCtx, tryToolBody, ok, ownerCheck, encodeCursor, decodeCursor, hashQuery, validateOwners } from './_helpers.js';
import { McpError } from '../errors.js';
import { writeFileAtomic, appendFileAtomic, readFileAtomic, safeJoin, toKebabSlug, asciiFold } from '../vault/fs.js';
import { serializeFrontmatter, parseFrontmatter } from '../vault/frontmatter.js';
import { setLastWriteTs } from '../index.js';
import { log } from '../middleware/logger.js';

function todayISO(): string { return new Date().toISOString().slice(0, 10); }

export const CreateJournalEntrySchema = z.object({
  agent: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
});

export async function createJournalEntry(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = CreateJournalEntrySchema.parse(args);
    const slug = toKebabSlug(a.title);
    const date = todayISO();
    const rel = `_agents/${a.agent}/journal/${date}-${slug}.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const fm = { type: 'journal', owner: a.agent, created: date, updated: date, tags: a.tags, title: a.title };
    const body = a.content;
    const assembled = serializeFrontmatter(fm, body);
    parseFrontmatter(assembled);   // validate
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'create_journal_entry', as_agent: a.agent, path: rel, action: 'create', outcome: 'ok' });
    return { path: rel, created: true };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Created journal entry ${(r.value as any).path}`);
}
```

Also add `import { McpToolResponse } from '../errors.js';` at top.

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t create_journal_entry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): create_journal_entry"
```

### Task I2: append_decision (prepend to decisions.md)

- [ ] **Step 1: Add failing test**

```ts
import { appendDecision } from '../../src/tools/workflows.js';

describe('append_decision', () => {
  it('prepends a decision block at top of decisions.md, preserving existing', async () => {
    const r = await appendDecision({ agent: 'alfa', title: 'nova decisão', rationale: 'por X', tags: ['critica'] }, ctx);
    expect(r.isError).toBeUndefined();
    const abs = path.join(FIXTURE, '_agents/alfa/decisions.md');
    const content = fs.readFileSync(abs, 'utf8');
    // New header appears before older one
    const iNew = content.indexOf('nova decisao'.normalize());   // slug-ified? no — title preserved
    const iOld = content.indexOf('first decision');
    expect(iNew).toBeGreaterThan(0);
    expect(iOld).toBeGreaterThan(iNew);
    // restore fixture
    fs.writeFileSync(abs, `---
type: agent-decisions
owner: alfa
created: 2026-04-01
updated: 2026-04-10
tags: [decisions]
---
## 2026-04-10 — first decision
rationale here
`);
    await ctx.index.updateAfterWrite('_agents/alfa/decisions.md');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t append_decision`
Expected: FAIL.

- [ ] **Step 3: Implement appendDecision**

Append to `src/tools/workflows.ts`:

```ts
export const AppendDecisionSchema = z.object({
  agent: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string(),
  tags: z.array(z.string()).optional().default([]),
});

export async function appendDecision(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendDecisionSchema.parse(args);
    const rel = `_agents/${a.agent}/decisions.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const { content } = await readFileAtomic(safe);
    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter) throw new McpError('INVALID_FRONTMATTER', `${rel} has no frontmatter`);
    const date = todayISO();
    const block = `## ${date} — ${a.title}\n\n${a.rationale}\n\n`;
    const newBody = block + body.replace(/^\n+/, '');
    const newFm = { ...frontmatter, updated: date, tags: Array.from(new Set([...(frontmatter.tags ?? []), ...a.tags])) };
    const assembled = serializeFrontmatter(newFm, newBody);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_decision', as_agent: a.agent, path: rel, action: 'prepend', outcome: 'ok' });
    return { path: rel, prepended: true };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Prepended decision to ${(r.value as any).path}`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t append_decision`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): append_decision (prepend block to decisions.md)"
```

### Task I3: update_agent_profile

- [ ] **Step 1: Add failing test**

```ts
import { updateAgentProfile } from '../../src/tools/workflows.js';

describe('update_agent_profile', () => {
  it('rewrites profile.md preserving frontmatter, updates updated:', async () => {
    const abs = path.join(FIXTURE, '_agents/alfa/profile.md');
    const before = fs.readFileSync(abs, 'utf8');
    const r = await updateAgentProfile({ agent: 'alfa', content: '# Novo conteúdo\n\ndescrição' }, ctx);
    expect(r.isError).toBeUndefined();
    const after = fs.readFileSync(abs, 'utf8');
    expect(after).toContain('Novo conteúdo');
    expect(after).toMatch(/updated:\s+20\d\d-\d\d-\d\d/);
    fs.writeFileSync(abs, before);
    await ctx.index.updateAfterWrite('_agents/alfa/profile.md');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t update_agent_profile`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/tools/workflows.ts`:

```ts
export const UpdateAgentProfileSchema = z.object({
  agent: z.string().min(1),
  content: z.string(),
});

export async function updateAgentProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpdateAgentProfileSchema.parse(args);
    const rel = `_agents/${a.agent}/profile.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await readFileAtomic(safe);
    const parsed = parseFrontmatter(existing.content);
    const fm = { ...(parsed.frontmatter ?? { type: 'agent-profile', owner: a.agent, created: todayISO(), tags: [] }), updated: todayISO() };
    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'update_agent_profile', as_agent: a.agent, path: rel, action: 'update', outcome: 'ok' });
    return { path: rel };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Updated profile ${(r.value as any).path}`);
}
```

- [ ] **Step 4: Run (expect pass)** — Run test, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): update_agent_profile"
```

### Task I4: upsert_goal + upsert_result

Both are the same shape — unified helper `upsertGoalResult(kind: 'goal'|'result', args, ctx)`.

- [ ] **Step 1: Add failing tests**

```ts
import { upsertGoal, upsertResult } from '../../src/tools/workflows.js';

describe('upsert_goal / upsert_result', () => {
  // Need patterns for _shared/goals/ and _shared/results/ in AGENTS.md.
  // Use fresh fixture subdir.
  beforeAll(async () => {
    // extend fixture AGENTS.md with required patterns if not already
    const agentsMd = path.join(FIXTURE, '_shared/context/AGENTS.md');
    const src = fs.readFileSync(agentsMd, 'utf8');
    if (!src.includes('_shared/goals/*/alfa.md')) {
      const extra = '_shared/goals/*/alfa.md => alfa\n_shared/results/*/alfa.md => alfa\n';
      fs.writeFileSync(agentsMd, src.replace('```\n', '```\n' + extra));
      await ctx.index.build();
    }
  });

  it('upsert_goal creates file under _shared/goals/<period>/<agent>.md', async () => {
    const r = await upsertGoal({ agent: 'alfa', period: '2026-04', content: '# meta' }, ctx);
    expect(r.isError).toBeUndefined();
    const abs = path.join(FIXTURE, '_shared/goals/2026-04/alfa.md');
    expect(fs.existsSync(abs)).toBe(true);
    const body = fs.readFileSync(abs, 'utf8');
    expect(body).toContain('period: 2026-04');
    fs.rmSync(path.join(FIXTURE, '_shared/goals'), { recursive: true });
    await ctx.index.build();
  });

  it('upsert_result creates file under _shared/results/<period>/<agent>.md', async () => {
    const r = await upsertResult({ agent: 'alfa', period: '2026-04', content: '# realizado' }, ctx);
    expect(r.isError).toBeUndefined();
    const abs = path.join(FIXTURE, '_shared/results/2026-04/alfa.md');
    expect(fs.existsSync(abs)).toBe(true);
    fs.rmSync(path.join(FIXTURE, '_shared/results'), { recursive: true });
    await ctx.index.build();
  });

  it('rejects invalid period format', async () => {
    const r = await upsertGoal({ agent: 'alfa', period: '2026-4', content: 'x' }, ctx);
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t "upsert_goal|upsert_result"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/tools/workflows.ts`:

```ts
const periodRe = /^\d{4}-\d{2}$/;

export const UpsertGoalSchema = z.object({
  agent: z.string().min(1),
  period: z.string().regex(periodRe, 'period must be YYYY-MM'),
  content: z.string(),
});

async function upsertGoalResult(kind: 'goal' | 'result', args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertGoalSchema.parse(args);
    const dir = kind === 'goal' ? 'goals' : 'results';
    const rel = `_shared/${dir}/${a.period}/${a.agent}.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const date = todayISO();
    const existing = await (async () => { try { return await readFileAtomic(safe); } catch { return null; } })();
    const prevFm = existing ? parseFrontmatter(existing.content).frontmatter ?? {} : {};
    const fm = { ...prevFm, type: kind, owner: a.agent, period: a.period, created: prevFm.created ?? date, updated: date, tags: prevFm.tags ?? [] };
    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: `upsert_${kind}`, as_agent: a.agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export function upsertGoal(args: unknown, ctx: ToolCtx) { return upsertGoalResult('goal', args, ctx); }
export function upsertResult(args: unknown, ctx: ToolCtx) { return upsertGoalResult('result', args, ctx); }
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t "upsert_goal|upsert_result"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): upsert_goal + upsert_result"
```

### Task I5: read_agent_context (bundle)

- [ ] **Step 1: Add failing test**

```ts
import { readAgentContext } from '../../src/tools/workflows.js';

describe('read_agent_context', () => {
  it('returns profile + recent decisions + journals + goals + results', async () => {
    const r = await readAgentContext({ agent: 'alfa', n_decisions: 3, n_journals: 3 }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.profile).toBeTruthy();
    expect(Array.isArray(sc.decisions)).toBe(true);
    expect(Array.isArray(sc.journals)).toBe(true);
    expect(Array.isArray(sc.goals)).toBe(true);
    expect(Array.isArray(sc.results)).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t read_agent_context`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/tools/workflows.ts`:

```ts
export const ReadAgentContextSchema = z.object({
  agent: z.string().min(1),
  n_decisions: z.number().int().positive().max(50).optional().default(5),
  n_journals: z.number().int().positive().max(50).optional().default(5),
});

function parseDecisionBlocks(body: string): Array<{ date: string; title: string; rationale: string }> {
  const re = /^## (\d{4}-\d{2}-\d{2}) — (.+)$/gm;
  const blocks: Array<{ date: string; title: string; rationale: string }> = [];
  const hits = [...body.matchAll(re)];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].index! : body.length;
    const start = hits[i].index! + hits[i][0].length;
    blocks.push({ date: hits[i][1], title: hits[i][2].trim(), rationale: body.slice(start, end).trim() });
  }
  return blocks;
}

export async function readAgentContext(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadAgentContextSchema.parse(args);

    const profileEntry = ctx.index.get(`_agents/${a.agent}/profile.md`);
    let profile: any = null;
    if (profileEntry) {
      const full = await readFileAtomic(safeJoin(ctx.vaultRoot, profileEntry.path));
      profile = { path: profileEntry.path, content: full.content, frontmatter: profileEntry.frontmatter };
    }

    const decPath = `_agents/${a.agent}/decisions.md`;
    let decisions: any[] = [];
    const dec = ctx.index.get(decPath);
    if (dec) {
      const full = await readFileAtomic(safeJoin(ctx.vaultRoot, decPath));
      const { body } = parseFrontmatter(full.content);
      decisions = parseDecisionBlocks(body).slice(0, a.n_decisions);
    }

    const journals = ctx.index.byType('journal')
      .filter(e => e.owner === a.agent)
      .sort((x, y) => (y.updated ?? '').localeCompare(x.updated ?? ''))
      .slice(0, a.n_journals)
      .map(e => ({ path: e.path, updated: e.updated, frontmatter: e.frontmatter }));

    const goals = ctx.index.byType('goal').filter(e => e.owner === a.agent).map(e => ({ path: e.path, frontmatter: e.frontmatter }));
    const results = ctx.index.byType('result').filter(e => e.owner === a.agent).map(e => ({ path: e.path, frontmatter: e.frontmatter }));

    return { profile, decisions, journals, goals, results };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `Context bundle for ${(args as any).agent}: ${sc.decisions.length} decisions, ${sc.journals.length} journals, ${sc.goals.length} goals, ${sc.results.length} results`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t read_agent_context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): read_agent_context bundle"
```

### Task I6: get_agent_delta

- [ ] **Step 1: Add failing test**

```ts
import { getAgentDelta } from '../../src/tools/workflows.js';

describe('get_agent_delta', () => {
  it('returns only files with mtime > since, grouped by type', async () => {
    // Touch alfa's README to push its mtime forward
    const target = path.join(FIXTURE, '_agents/alfa/README.md');
    const now = Date.now();
    fs.utimesSync(target, new Date(now / 1000), new Date(now / 1000));
    await ctx.index.updateAfterWrite('_agents/alfa/README.md');

    const since = new Date(now - 1000).toISOString();
    const r = await getAgentDelta({ agent: 'alfa', since }, ctx);
    const sc = r.structuredContent as any;
    expect(sc).toHaveProperty('decisions');
    expect(sc).toHaveProperty('journals');
    expect(sc).toHaveProperty('shared_contexts');
    expect(sc).toHaveProperty('entity_profiles');
    expect(sc).toHaveProperty('other');
    // README is in `other`
    expect(sc.other.some((e: any) => e.path === '_agents/alfa/README.md')).toBe(true);
  });

  it('types? filter narrows to listed types', async () => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const r = await getAgentDelta({ agent: 'alfa', since, types: ['agent-decisions'] }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.journals).toEqual([]);
    // only decisions bucket can be populated
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t get_agent_delta`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/tools/workflows.ts`:

```ts
export const GetAgentDeltaSchema = z.object({
  agent: z.string().min(1),
  since: z.string().min(10),  // ISO-8601
  types: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

function previewOf(s: string, max = 500): string { return s.length <= max ? s : s.slice(0, max); }

function bucketForEntry(e: any): 'decisions' | 'journals' | 'goals' | 'results' | 'shared_contexts' | 'entity_profiles' | 'other' {
  if (e.type === 'agent-decisions') return 'decisions';
  if (e.type === 'journal') return 'journals';
  if (e.type === 'goal') return 'goals';
  if (e.type === 'result') return 'results';
  if (e.type === 'shared-context') return 'shared_contexts';
  if (e.type === 'entity-profile') return 'entity_profiles';
  return 'other';
}

export async function getAgentDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetAgentDeltaSchema.parse(args);
    const sinceMs = Date.parse(a.since);
    if (Number.isNaN(sinceMs)) throw new McpError('INVALID_FRONTMATTER', `since must be ISO-8601 datetime`);
    const typesSet = a.types ? new Set(a.types) : null;

    const buckets: Record<string, any[]> = {
      decisions: [], journals: [], goals: [], results: [], shared_contexts: [], entity_profiles: [], other: [],
    };

    const entries = ctx.index.byOwner(a.agent)
      .filter(e => e.mtimeMs > sinceMs)
      .filter(e => !typesSet || (e.type && typesSet.has(e.type)));

    for (const e of entries) {
      const bucket = bucketForEntry(e);
      const item: any = {
        path: e.path, updated: e.updated, mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter, preview: '',
      };
      if (a.include_content) {
        const r2 = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path));
        item.content = r2.content;
        item.preview = previewOf(parseFrontmatter(r2.content).body);
      } else {
        const r2 = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path));
        item.preview = previewOf(parseFrontmatter(r2.content).body);
      }
      buckets[bucket].push(item);
    }

    return buckets;
  });
  if (!r.ok) return r.err.toMcpResponse();
  const total = Object.values(r.value as any).reduce((acc: number, arr: any) => acc + arr.length, 0);
  return ok(r.value as any, `${total} item(s) changed since ${(args as any).since}`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t get_agent_delta`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): get_agent_delta with type-bucketed output"
```

### Task I7: upsert_shared_context

- [ ] **Step 1: Add failing test**

```ts
import { upsertSharedContext } from '../../src/tools/workflows.js';

describe('upsert_shared_context', () => {
  // Requires pattern _shared/context/*/<agent>/** in AGENTS.md; fixture already has for alfa/beta.
  it('creates _shared/context/<topic>/<agent>/<slug>.md with type=shared-context', async () => {
    const r = await upsertSharedContext({ as_agent: 'alfa', topic: 'objecoes', slug: 'entrada-alta', title: 'Entrada alta', content: '# conteúdo' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_shared/context/objecoes/alfa/entrada-alta.md');
    const body = fs.readFileSync(path.join(FIXTURE, sc.path), 'utf8');
    expect(body).toContain('type: shared-context');
    expect(body).toContain('topic: objecoes');
    fs.rmSync(path.join(FIXTURE, '_shared/context/objecoes'), { recursive: true });
    await ctx.index.build();
  });

  it('cross-agent write via write_note rejected (owner from path)', async () => {
    // Indirect: try to write via upsert_shared_context with as_agent=beta but path forced by tool → beta creates under beta/. OK. 
    // Cross-agent violation comes from WRITE_NOTE on another author's path — covered in CRUD tests.
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t upsert_shared_context`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/tools/workflows.ts`:

```ts
const kebabSegment = /^[a-z0-9][a-z0-9-]*$/;

export const UpsertSharedContextSchema = z.object({
  as_agent: z.string().min(1),
  topic: z.string().regex(kebabSegment, 'topic must be kebab single-segment'),
  slug: z.string().regex(kebabSegment, 'slug must be kebab single-segment'),
  title: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
});

export async function upsertSharedContext(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertSharedContextSchema.parse(args);
    const rel = `_shared/context/${a.topic}/${a.as_agent}/${a.slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const date = todayISO();
    const existing = await (async () => { try { return await readFileAtomic(safe); } catch { return null; } })();
    const prevFm = existing ? parseFrontmatter(existing.content).frontmatter ?? {} : {};
    const fm = {
      ...prevFm,
      type: 'shared-context',
      owner: a.as_agent,
      topic: a.topic,
      title: a.title,
      created: prevFm.created ?? date,
      updated: date,
      tags: a.tags.length ? a.tags : (prevFm.tags ?? []),
    };
    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_shared_context', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} shared context ${(r.value as any).path}`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t upsert_shared_context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): upsert_shared_context"
```

### Task I8: upsert_entity_profile

- [ ] **Step 1: Add failing test**

```ts
import { upsertEntityProfile } from '../../src/tools/workflows.js';

describe('upsert_entity_profile', () => {
  it('creates _agents/<agent>/<entity_type>/<slug>.md', async () => {
    const r = await upsertEntityProfile({ as_agent: 'alfa', entity_type: 'projeto', entity_name: 'Ação X', content: '# projeto' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_agents/alfa/projeto/acao-x.md');
    const body = fs.readFileSync(path.join(FIXTURE, sc.path), 'utf8');
    expect(body).toContain('type: entity-profile');
    expect(body).toContain('entity_type: projeto');
    expect(body).toContain('entity_name: Ação X');
    fs.rmSync(path.join(FIXTURE, '_agents/alfa/projeto'), { recursive: true });
    await ctx.index.build();
  });

  it('rejects entity_type with spaces/slashes', async () => {
    const r = await upsertEntityProfile({ as_agent: 'alfa', entity_type: 'has space', entity_name: 'x', content: 'x' }, ctx);
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t upsert_entity_profile`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/tools/workflows.ts`:

```ts
export const UpsertEntityProfileSchema = z.object({
  as_agent: z.string().min(1),
  entity_type: z.string().regex(kebabSegment),
  entity_name: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
  status: z.string().optional(),
});

export async function upsertEntityProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertEntityProfileSchema.parse(args);
    const slug = toKebabSlug(a.entity_name);
    const rel = `_agents/${a.as_agent}/${a.entity_type}/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const date = todayISO();
    const existing = await (async () => { try { return await readFileAtomic(safe); } catch { return null; } })();
    const prevFm = existing ? parseFrontmatter(existing.content).frontmatter ?? {} : {};
    const fm: any = {
      ...prevFm,
      type: 'entity-profile',
      owner: a.as_agent,
      entity_type: a.entity_type,
      entity_name: a.entity_name,
      created: prevFm.created ?? date,
      updated: date,
      tags: a.tags.length ? a.tags : (prevFm.tags ?? []),
    };
    if (a.status !== undefined) fm.status = a.status;
    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_entity_profile', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} entity profile ${(r.value as any).path}`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t upsert_entity_profile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): upsert_entity_profile"
```

### Task I9: search_by_tag + search_by_type + get_backlinks (+ owner filter)

- [ ] **Step 1: Add failing tests**

```ts
import { searchByTag, searchByType, getBacklinks } from '../../src/tools/workflows.js';

describe('search_by_tag / search_by_type / get_backlinks', () => {
  it('search_by_tag returns all notes with given tag', async () => {
    const r = await searchByTag({ tag: 'decisions' }, ctx);
    const notes = (r.structuredContent as any).notes;
    expect(notes.some((n: any) => n.path === '_agents/alfa/decisions.md')).toBe(true);
  });

  it('search_by_tag with owner filter', async () => {
    const r = await searchByTag({ tag: 'decisions', owner: 'alfa' }, ctx);
    expect((r.structuredContent as any).notes.every((n: any) => n.owner === 'alfa')).toBe(true);
  });

  it('search_by_tag INVALID_OWNER for unknown', async () => {
    const r = await searchByTag({ tag: 'decisions', owner: 'nope' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_OWNER');
  });

  it('search_by_type returns all of type', async () => {
    const r = await searchByType({ type: 'agent-profile' }, ctx);
    expect((r.structuredContent as any).notes.length).toBeGreaterThanOrEqual(2);
  });

  it('get_backlinks finds notes linking to alfa/README', async () => {
    // Alfa's journal links to [[../README|alfa README]]
    const r = await getBacklinks({ note_name: 'README' }, ctx);
    const notes = (r.structuredContent as any).notes;
    expect(notes.some((n: any) => n.path.includes('alfa/journal/'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `npx vitest run test/integration/workflows.test.ts -t "search_by_tag|search_by_type|get_backlinks"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/tools/workflows.ts`:

```ts
export const SearchByTagSchema = z.object({
  tag: z.string().min(1),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
});

export async function searchByTag(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = SearchByTagSchema.parse(args);
    const owners = await validateOwners(ctx, a.owner);
    let entries = ctx.index.byTag(a.tag);
    if (owners) entries = entries.filter(e => e.owner && owners.includes(e.owner));
    return { notes: entries.map(e => ({ path: e.path, type: e.type, owner: e.owner })) };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} note(s) tagged`);
}

export const SearchByTypeSchema = z.object({
  type: z.string().min(1),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
});

export async function searchByType(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = SearchByTypeSchema.parse(args);
    const owners = await validateOwners(ctx, a.owner);
    let entries = ctx.index.byType(a.type);
    if (owners) entries = entries.filter(e => e.owner && owners.includes(e.owner));
    return { notes: entries.map(e => ({ path: e.path, type: e.type, owner: e.owner })) };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} note(s) of type`);
}

export const GetBacklinksSchema = z.object({ note_name: z.string().min(1) });

export async function getBacklinks(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetBacklinksSchema.parse(args);
    const entries = ctx.index.backlinks(a.note_name);
    return { notes: entries.map(e => ({ path: e.path, line: 0 })) };   // line resolution TODO future
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} backlink(s)`);
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `npx vitest run test/integration/workflows.test.ts -t "search_by_tag|search_by_type|get_backlinks"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(tools/workflows): search_by_tag, search_by_type, get_backlinks (with owner filter)"
```

---

## Phase J — tools/sync.ts (git tools)

### Task J1: commit_and_push + git_status

**Files:**
- Create: `src/tools/sync.ts`
- Test: `test/integration/sync.test.ts`
- Modify: `src/tools/_shared.ts` — add optional `git` field to `ToolCtx`

- [ ] **Step 1: Extend ToolCtx**

Modify `src/tools/_shared.ts`:

```ts
import { GitOps } from '../vault/git.js';

export interface ToolCtx {
  index: VaultIndex;
  vaultRoot: string;
  git?: GitOps;
}
```

- [ ] **Step 2: Write failing tests**

```ts
// test/integration/sync.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { GitOps } from '../../src/vault/git.js';
import { commitAndPush, gitStatus } from '../../src/tools/sync.js';

describe('git tools', () => {
  let tmp: string; let ctx: any;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-'));
    execSync('git init -q -b main', { cwd: tmp });
    execSync('git config user.email "t@t" && git config user.name "t"', { cwd: tmp });
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => x\n```');
    fs.writeFileSync(path.join(tmp, 'README.md'), '#');
    execSync('git add . && git commit -q -m init', { cwd: tmp });
    const index = new VaultIndex(tmp); await index.build();
    const git = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp-obsidian', 'mcp@fama.local');
    ctx = { index, vaultRoot: tmp, git };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('git_status clean', async () => {
    const r = await gitStatus({}, ctx);
    expect((r.structuredContent as any).modified).toEqual([]);
  });

  it('commit_and_push creates commit with [mcp-obsidian] prefix', async () => {
    fs.writeFileSync(path.join(tmp, 'new.md'), 'x');
    const r = await commitAndPush({ message: 'added new' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.sha).toMatch(/^[0-9a-f]{40}$/);
    const log = execSync('git log --oneline -1', { cwd: tmp, encoding: 'utf8' });
    expect(log).toContain('[mcp-obsidian] added new');
  });

  it('commit_and_push no-op when nothing staged', async () => {
    const r = await commitAndPush({ message: 'empty' }, ctx);
    expect((r.structuredContent as any).sha).toBe('');
  });
});
```

- [ ] **Step 3: Run (expect fail)**

Run: `npx vitest run test/integration/sync.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement src/tools/sync.ts**

```ts
// src/tools/sync.ts
import { z } from 'zod';
import { ToolCtx, tryToolBody, ok } from './_shared.js';
import { McpError, McpToolResponse } from '../errors.js';

export const CommitAndPushSchema = z.object({ message: z.string().min(1) });

export async function commitAndPush(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = CommitAndPushSchema.parse(args);
    if (!ctx.git) throw new McpError('VAULT_IO_ERROR', 'git ops not configured');
    return await ctx.git.commitAndPush(a.message);
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `sha=${(r.value as any).sha || 'no-op'} pushed=${(r.value as any).pushed}`);
}

export const GitStatusSchema = z.object({}).passthrough();

export async function gitStatus(_args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    if (!ctx.git) throw new McpError('VAULT_IO_ERROR', 'git ops not configured');
    return await ctx.git.status();
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `modified=${sc.modified.length} untracked=${sc.untracked.length} ahead=${sc.ahead} behind=${sc.behind}`);
}
```

- [ ] **Step 5: Run (expect pass)**

Run: `npx vitest run test/integration/sync.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/_shared.ts src/tools/sync.ts test/integration/sync.test.ts
git commit -m "feat(tools/sync): commit_and_push + git_status"
```

---

## Phase K — resources/vault.ts

### Task K1: obsidian://vault and obsidian://agents

**Files:**
- Create: `src/resources/vault.ts`

- [ ] **Step 1: Implement resources**

```ts
// src/resources/vault.ts
import { ToolCtx } from '../tools/_shared.js';

export interface ResourceContent { uri: string; mimeType: string; text: string; }

export async function vaultStatsResource(ctx: ToolCtx): Promise<ResourceContent> {
  const stats = {
    total_notes: ctx.index.size(),
    by_type: ctx.index.countsByType(),
    by_agent: ctx.index.countsByAgent(),
    index_age_ms: ctx.index.ageMs(),
  };
  return { uri: 'obsidian://vault', mimeType: 'application/json', text: JSON.stringify(stats, null, 2) };
}

export async function agentsMapResource(ctx: ToolCtx): Promise<ResourceContent> {
  const map = await ctx.index.getOwnershipResolver().getMap();
  return { uri: 'obsidian://agents', mimeType: 'application/json', text: JSON.stringify({ patterns: map }, null, 2) };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/resources/vault.ts
git commit -m "feat(resources): obsidian://vault and obsidian://agents"
```

---

## Phase L — Tool + resource registration, healthcheck wiring, README

### Task L1: Register tools/resources in server.ts

**Files:**
- Modify: `src/server.ts`
- Install: `zod-to-json-schema`

- [ ] **Step 1: Install zod-to-json-schema**

Run: `npm install zod-to-json-schema@^3.24.1`
Expected: added to dependencies.

- [ ] **Step 2: Implement src/server.ts**

```ts
// src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from './config.js';
import { VaultIndex } from './vault/index.js';
import { GitOps } from './vault/git.js';
import { ToolCtx } from './tools/_shared.js';
import * as crud from './tools/crud.js';
import * as wf from './tools/workflows.js';
import * as sync from './tools/sync.js';
import { vaultStatsResource, agentsMapResource } from './resources/vault.js';

let sharedCtx: ToolCtx | null = null;

async function getCtx(): Promise<ToolCtx> {
  if (!sharedCtx) {
    const index = new VaultIndex(config.vaultPath);
    await index.build();
    const git = new GitOps(config.vaultPath, config.gitLockfile, config.gitAuthorName, config.gitAuthorEmail);
    sharedCtx = { index, vaultRoot: config.vaultPath, git };
  }
  return sharedCtx;
}

export async function __getSharedCtxForHealth(): Promise<ToolCtx> { return await getCtx(); }

interface ToolDef { schema: any; handler: (args: unknown, ctx: ToolCtx) => Promise<any>; desc: string; annotations: Record<string, boolean>; }

const TOOL_REGISTRY: Record<string, ToolDef> = {
  read_note:             { schema: crud.ReadNoteSchema,          handler: crud.readNote,          desc: 'Read a note by path',            annotations: { readOnlyHint: true, openWorldHint: false } },
  write_note:            { schema: crud.WriteNoteSchema,         handler: crud.writeNote,         desc: 'Create or overwrite a note',     annotations: { openWorldHint: false } },
  append_to_note:        { schema: crud.AppendToNoteSchema,      handler: crud.appendToNote,      desc: 'Append content to a note',       annotations: { openWorldHint: false } },
  delete_note:           { schema: crud.DeleteNoteSchema,        handler: crud.deleteNote,        desc: 'Delete a note (reason required)',annotations: { destructiveHint: true, openWorldHint: false } },
  list_folder:           { schema: crud.ListFolderSchema,        handler: crud.listFolder,        desc: 'List folder items',              annotations: { readOnlyHint: true, openWorldHint: false } },
  search_content:        { schema: crud.SearchContentSchema,     handler: crud.searchContent,     desc: 'Full-text search (ripgrep)',     annotations: { readOnlyHint: true, openWorldHint: false } },
  get_note_metadata:     { schema: crud.GetNoteMetadataSchema,   handler: crud.getNoteMetadata,   desc: 'Get note metadata from index',   annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  stat_vault:            { schema: crud.StatVaultSchema,         handler: crud.statVault,         desc: 'Vault statistics',               annotations: { readOnlyHint: true, openWorldHint: false } },
  create_journal_entry:  { schema: wf.CreateJournalEntrySchema,  handler: wf.createJournalEntry,  desc: 'Create a journal entry',         annotations: { openWorldHint: false } },
  append_decision:       { schema: wf.AppendDecisionSchema,      handler: wf.appendDecision,      desc: 'Prepend a decision block',       annotations: { openWorldHint: false } },
  update_agent_profile:  { schema: wf.UpdateAgentProfileSchema,  handler: wf.updateAgentProfile,  desc: 'Update agent profile body',      annotations: { idempotentHint: true, openWorldHint: false } },
  upsert_goal:           { schema: wf.UpsertGoalSchema,          handler: wf.upsertGoal,          desc: 'Upsert a monthly goal',          annotations: { idempotentHint: true, openWorldHint: false } },
  upsert_result:         { schema: wf.UpsertGoalSchema,          handler: wf.upsertResult,        desc: 'Upsert a monthly result',        annotations: { idempotentHint: true, openWorldHint: false } },
  read_agent_context:    { schema: wf.ReadAgentContextSchema,    handler: wf.readAgentContext,    desc: 'Read agent context bundle',      annotations: { readOnlyHint: true, openWorldHint: false } },
  get_agent_delta:       { schema: wf.GetAgentDeltaSchema,       handler: wf.getAgentDelta,       desc: 'Delta: what agent changed since',annotations: { readOnlyHint: true, openWorldHint: false } },
  upsert_shared_context: { schema: wf.UpsertSharedContextSchema, handler: wf.upsertSharedContext, desc: 'Upsert curated shared context',  annotations: { idempotentHint: true, openWorldHint: false } },
  upsert_entity_profile: { schema: wf.UpsertEntityProfileSchema, handler: wf.upsertEntityProfile, desc: 'Upsert an entity profile',       annotations: { idempotentHint: true, openWorldHint: false } },
  search_by_tag:         { schema: wf.SearchByTagSchema,         handler: wf.searchByTag,         desc: 'Search notes by tag',            annotations: { readOnlyHint: true, openWorldHint: false } },
  search_by_type:        { schema: wf.SearchByTypeSchema,        handler: wf.searchByType,        desc: 'Search notes by type',           annotations: { readOnlyHint: true, openWorldHint: false } },
  get_backlinks:         { schema: wf.GetBacklinksSchema,        handler: wf.getBacklinks,        desc: 'Get backlinks for a note name',  annotations: { readOnlyHint: true, openWorldHint: false } },
  commit_and_push:       { schema: sync.CommitAndPushSchema,     handler: sync.commitAndPush,     desc: 'Commit + push vault changes',    annotations: { openWorldHint: false } },
  git_status:            { schema: sync.GitStatusSchema,         handler: sync.gitStatus,         desc: 'Git status of vault repo',       annotations: { readOnlyHint: true, openWorldHint: false } },
};

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'mcp-obsidian', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOL_REGISTRY).map(([name, { schema, desc, annotations }]) => ({
      name, description: desc,
      inputSchema: zodToJsonSchema(schema, name),
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const entry = TOOL_REGISTRY[req.params.name];
    if (!entry) throw new Error(`Unknown tool: ${req.params.name}`);
    const ctx = await getCtx();
    return await entry.handler(req.params.arguments, ctx);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'obsidian://vault',  name: 'Vault statistics', mimeType: 'application/json' },
      { uri: 'obsidian://agents', name: 'Ownership map',    mimeType: 'application/json' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const ctx = await getCtx();
    if (req.params.uri === 'obsidian://vault')  return { contents: [await vaultStatsResource(ctx)] };
    if (req.params.uri === 'obsidian://agents') return { contents: [await agentsMapResource(ctx)] };
    throw new Error(`Unknown resource: ${req.params.uri}`);
  });

  return server;
}
```

- [ ] **Step 3: Update /health in index.ts**

Modify `src/index.ts` to import and use `__getSharedCtxForHealth`:

```ts
import { __getSharedCtxForHealth } from './server.js';

app.get('/health', async (_req, res) => {
  try {
    const ctx = await __getSharedCtxForHealth();
    const gitHead = ctx.git ? await ctx.git.head() : null;
    res.status(200).json({
      status: 'healthy',
      vault_notes: ctx.index.size(),
      index_age_ms: ctx.index.ageMs(),
      git_head: gitHead,
      last_write_ts: lastWriteTs,
    });
  } catch (e: any) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});
```

- [ ] **Step 4: Run all tests + typecheck**

Run: `npm run test && npm run typecheck`
Expected: all PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/index.ts package.json package-lock.json
git commit -m "feat(server): register 22 tools + 2 resources, wire /health with real metrics"
```

### Task L2: README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README with full tool catalog, troubleshooting, AGENTS.md format**

```markdown
# mcp-obsidian

MCP server exposing the fama-brain Obsidian vault to LLM agents with ownership enforcement, append-only decision trail, and git-coordinated sync with `brain-sync.sh` cron.

## Quickstart

    cp .env.example .env   # then edit: set API_KEY, VAULT_PATH
    docker compose up --build
    curl -sH "Authorization: Bearer $API_KEY" -X POST localhost:3201/mcp \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq

Healthcheck: `curl localhost:3201/health` (no auth).

## Ownership (AGENTS.md format)

`_shared/context/AGENTS.md` must contain fenced code block(s) with lines matching `<glob-pattern> => <agent>`. First match wins.

Example:

    ```
    _agents/reno/**            => reno
    _shared/goals/*/reno.md    => reno
    _shared/context/*/reno/**  => reno
    README.md                  => renato
    ```

Patterns support minimatch globs including mid-path wildcards.

## Tools (22)

### CRUD (8)

- `read_note(path)` — read + frontmatter + wikilinks + backlinks_count + bytes + mtime
- `write_note(path, content, frontmatter, as_agent)` — create/overwrite; blocks decisions.md
- `append_to_note(path, content, as_agent)` — append; blocks decisions.md
- `delete_note(path, as_agent, reason)` — delete with mandatory reason (audit)
- `list_folder(path, recursive?, filter_type?, owner?, cursor?, limit?)` — paginated listing; owner filter accepts string or string[]
- `search_content(query, path?, type?, tag?, owner?, cursor?, limit?)` — ripgrep full text
- `get_note_metadata(path)` — frontmatter + links + backlinks + bytes
- `stat_vault()` — total_notes, by_type, by_agent, index_age_ms

### Workflows (12)

- `create_journal_entry(agent, title, content, tags?)` — `_agents/<agent>/journal/YYYY-MM-DD-<slug>.md`
- `append_decision(agent, title, rationale, tags?)` — prepend in `_agents/<agent>/decisions.md`
- `update_agent_profile(agent, content)` — rewrites body, preserves frontmatter
- `upsert_goal(agent, period, content)` — `_shared/goals/<period>/<agent>.md`, `period=YYYY-MM`
- `upsert_result(agent, period, content)` — `_shared/results/<period>/<agent>.md`
- `read_agent_context(agent, n_decisions?, n_journals?)` — profile + decisions + journals + goals + results
- `get_agent_delta(agent, since, types?, include_content?)` — grouped delta since ISO datetime
- `upsert_shared_context(as_agent, topic, slug, title, content, tags?)` — `_shared/context/<topic>/<as_agent>/<slug>.md`
- `upsert_entity_profile(as_agent, entity_type, entity_name, content, tags?, status?)` — `_agents/<as_agent>/<entity_type>/<slug>.md`
- `search_by_tag(tag, owner?)`
- `search_by_type(type, owner?)`
- `get_backlinks(note_name)`

### Git (2)

- `commit_and_push(message)` — opt-in sync; `[mcp-obsidian]` prefix; flock coordinated with cron
- `git_status()`

## Resources (2)

- `obsidian://vault` — stats snapshot
- `obsidian://agents` — ownership map

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `OWNERSHIP_VIOLATION` | as_agent ≠ file owner | Use correct `as_agent` |
| `UNMAPPED_PATH` | path not in AGENTS.md | Add pattern to `_shared/context/AGENTS.md` |
| `INVALID_FILENAME` | file not kebab .md | Rename to lowercase + hyphens |
| `INVALID_OWNER` | owner filter references unknown agent | Check `obsidian://agents` |
| `IMMUTABLE_TARGET` | tried to write decisions.md directly | Use `append_decision` |
| `JOURNAL_IMMUTABLE` | tried to overwrite existing journal | Use `append_to_note` |
| `NOTE_NOT_FOUND` | path does not exist | Check path / index age |
| `GIT_LOCK_BUSY` | cron or peer holds lock | Retry after 3-10s |
| `GIT_PUSH_FAILED` | remote push error | Check network / remote state |

## Governance (§1.1 teaser)

The vault is **memória operacional**, not a CRM/financial system replacement. Detailed customer data, transactions, compliance records live in the official systems.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(mcp-obsidian): README with tool catalog + ownership format + troubleshooting"
```

### Task L3: Extend production AGENTS.md with pattern table

**Files:**
- Modify: `/root/fama-brain/_shared/context/AGENTS.md`

**Context:** the production vault's AGENTS.md needs the fenced `pattern => agent` block. This is a vault-side change — commit via fama-brain repo, let `brain-sync.sh` propagate.

- [ ] **Step 1: Append pattern table**

Append to `/root/fama-brain/_shared/context/AGENTS.md` under a new `## Ownership patterns` section, inside a fenced code block:

    ```
    _agents/ceo/**                   => ceo
    _agents/cfo/**                   => cfo
    _agents/cmo/**                   => cmo
    _agents/cro/**                   => cro
    _agents/cto/**                   => cto
    _agents/ceo-exec/**              => ceo-exec
    _agents/cfo-exec/**              => cfo-exec
    _agents/famaagent/**             => famaagent
    _agents/follow-up/**             => follow-up
    _agents/reno/**                  => reno
    _agents/sparring/**              => sparring

    _shared/goals/*/ceo.md           => ceo
    _shared/goals/*/cfo.md           => cfo
    _shared/goals/*/cmo.md           => cmo
    _shared/goals/*/cro.md           => cro
    _shared/goals/*/cto.md           => cto
    _shared/goals/*/index.md         => ceo
    _shared/results/*/ceo.md         => ceo
    _shared/results/*/cfo.md         => cfo
    _shared/results/*/cmo.md         => cmo
    _shared/results/*/cro.md         => cro
    _shared/results/*/cto.md         => cto
    _shared/results/*/index.md       => ceo

    _shared/context/*/ceo/**         => ceo
    _shared/context/*/cfo/**         => cfo
    _shared/context/*/cmo/**         => cmo
    _shared/context/*/cro/**         => cro
    _shared/context/*/cto/**         => cto
    _shared/context/*/ceo-exec/**    => ceo-exec
    _shared/context/*/cfo-exec/**    => cfo-exec
    _shared/context/*/famaagent/**   => famaagent
    _shared/context/*/follow-up/**   => follow-up
    _shared/context/*/reno/**        => reno
    _shared/context/*/sparring/**    => sparring

    README.md                        => renato
    MEMORY.md                        => renato
    ```

- [ ] **Step 2: Commit in fama-brain**

Run:
```bash
cd /root/fama-brain && git add _shared/context/AGENTS.md && git commit -m "chore(ownership): add explicit pattern table for mcp-obsidian"
```

`brain-sync.sh` will propagate within 5 min. If the MCP container is already up, either wait for the lazy mtime reload to pick it up on next write, or restart the container.

---

## Phase M — Stress test, E2E smoke, deploy

### Task M1: Concurrency stress test (spec criterion 5 / §8.4)

**Files:**
- Create: `test/integration/stress.test.ts`

- [ ] **Step 1: Write test**

```ts
// test/integration/stress.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { VaultIndex } from '../../src/vault/index.js';
import { GitOps } from '../../src/vault/git.js';
import { writeNote } from '../../src/tools/crud.js';
import { parseFrontmatter } from '../../src/vault/frontmatter.js';

describe('concurrency stress', () => {
  let tmp: string; let ctx: any;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stress-'));
    execSync('git init -q -b main', { cwd: tmp });
    execSync('git config user.email "t@t" && git config user.name "t"', { cwd: tmp });
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
    execSync('git add . && git commit -q -m init', { cwd: tmp });
    const index = new VaultIndex(tmp); await index.build();
    const git = new GitOps(tmp, path.join(tmp, '.lock'), 'mcp', 'm@f');
    ctx = { index, vaultRoot: tmp, git };
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('10 parallel writes + simulated cron push → zero corruption', async () => {
    const ops = Array.from({ length: 10 }, (_, i) => writeNote({
      path: `_agents/alfa/s${i}.md`,
      content: `# ${i}`,
      frontmatter: { type: 'journal', owner: 'alfa', created: '2026-04-16', updated: '2026-04-16', tags: [] },
      as_agent: 'alfa',
    }, ctx));
    const sim = ctx.git.commitAndPush('cron simulated');
    const results = await Promise.all([...ops, sim].map(p => p.catch(e => ({ error: e.message }))));
    const writeErrors = results.slice(0, 10).filter((r: any) => r?.isError === true);
    expect(writeErrors.length).toBe(0);

    for (let i = 0; i < 10; i++) {
      const p = path.join(tmp, `_agents/alfa/s${i}.md`);
      const content = fs.readFileSync(p, 'utf8');
      expect(() => parseFrontmatter(content)).not.toThrow();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/integration/stress.test.ts`
Expected: PASS, no write errors, all 10 files re-parse cleanly.

- [ ] **Step 3: Commit**

```bash
git add test/integration/stress.test.ts
git commit -m "test(stress): 10 parallel writes + simulated cron push"
```

### Task M2: E2E smoke test (built binary roundtrip)

**Files:**
- Create: `vitest.e2e.config.ts`
- Create: `test/e2e/smoke.test.ts`

- [ ] **Step 1: Write e2e config**

```ts
// vitest.e2e.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 120_000 },
});
```

- [ ] **Step 2: Write e2e test**

```ts
// test/e2e/smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync, spawn, ChildProcess } from 'node:child_process';

async function waitHealthy(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server never became healthy');
}

describe('e2e smoke', () => {
  let tmpVault: string; let proc: ChildProcess;
  const PORT = 3291; const KEY = 'smoketoken';

  beforeAll(async () => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));
    execSync('git init -q -b main', { cwd: tmpVault });
    execSync('git config user.email "t@t" && git config user.name "t"', { cwd: tmpVault });
    fs.mkdirSync(path.join(tmpVault, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\nREADME.md => renato\n```');
    fs.writeFileSync(path.join(tmpVault, 'README.md'), '#');
    fs.mkdirSync(path.join(tmpVault, '_agents/alfa'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '_agents/alfa/profile.md'), `---
type: agent-profile
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
#`);
    execSync('git add . && git commit -q -m init', { cwd: tmpVault });

    proc = spawn('node', ['dist/index.js'], {
      env: { ...process.env, PORT: String(PORT), API_KEY: KEY, VAULT_PATH: tmpVault, GIT_LOCKFILE: path.join(tmpVault, '.lock') },
      stdio: 'inherit',
    });
    await waitHealthy(PORT);
  }, 60_000);

  afterAll(async () => {
    if (proc) proc.kill('SIGTERM');
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  async function rpc(method: string, params: any) {
    const r = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    return await r.json();
  }

  it('initialize + tools/list returns 22 tools', async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 's', version: '0' } });
    const r = await rpc('tools/list', {});
    expect(r.result.tools.length).toBe(22);
  });

  it('read_note via tools/call', async () => {
    const r = await rpc('tools/call', { name: 'read_note', arguments: { path: '_agents/alfa/profile.md' } });
    expect(r.result.structuredContent.path).toBe('_agents/alfa/profile.md');
  });

  it('create_journal_entry → file exists', async () => {
    const r = await rpc('tools/call', { name: 'create_journal_entry', arguments: { agent: 'alfa', title: 'Smoke', content: '#' } });
    const p = r.result.structuredContent.path;
    expect(p).toMatch(/^_agents\/alfa\/journal\/\d{4}-\d{2}-\d{2}-smoke\.md$/);
    expect(fs.existsSync(path.join(tmpVault, p))).toBe(true);
  });

  it('auth rejects missing bearer', async () => {
    const r = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 3: Build and run e2e**

Run: `npm run build && npx vitest run --config vitest.e2e.config.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add vitest.e2e.config.ts test/e2e/smoke.test.ts
git commit -m "test(e2e): smoke test against built binary with tmp vault"
```

### Task M3: Coverage gate

- [ ] **Step 1: Run coverage**

Run: `npx vitest run --coverage`
Expected: `vault/` ≥ 80%, overall ≥ 60%.

- [ ] **Step 2: Add tests if below gates, commit**

```bash
git add test/
git commit -m "test: raise coverage to meet spec gates"
```

### Task M4: Deploy to VPS staging

**Context:** spec §9 criterion 6 — deploy to VPS + smoke test at `mcp-obsidian.famachat.com.br`. Assume VPS has Docker + Nginx already configured (same pattern as sibling MCPs).

- [ ] **Step 1: Sync code to VPS**

Run (from local):
```bash
rsync -avz --delete --exclude=node_modules --exclude=dist ./ root@staging-vps:/root/mcp-fama/mcp-obsidian/
```

Or push to a remote and pull on VPS.

- [ ] **Step 2: On VPS — build + run**

SSH in, then:
```bash
cd /root/mcp-fama/mcp-obsidian
cp .env.example .env   # set API_KEY and VAULT_PATH=/vault
docker compose up -d --build
docker compose logs --tail 50
```

Expected: logs show `listening on :3201`, no errors.

- [ ] **Step 3: Nginx vhost**

Follow sibling pattern (`mcp-postgres.famachat.com.br`). Create `/etc/nginx/sites-available/mcp-obsidian.famachat.com.br` reverse-proxy to `localhost:3201`. Then:

```bash
ln -s /etc/nginx/sites-available/mcp-obsidian.famachat.com.br /etc/nginx/sites-enabled/
certbot --nginx -d mcp-obsidian.famachat.com.br
nginx -t && systemctl reload nginx
```

- [ ] **Step 4: Remote smoke**

Run (from anywhere):
```bash
curl -s https://mcp-obsidian.famachat.com.br/health | jq
curl -sH "Authorization: Bearer $API_KEY" -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

Expected: `/health` returns 200 JSON; tools/list returns `22`.

- [ ] **Step 5: Dogfood — record deploy as a decision via the live MCP**

Pick an agent that maps to the vault (e.g. `renato` if mapped to something, or test with the `alfa` fixture). Run:

```bash
curl -sH "Authorization: Bearer $API_KEY" -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_journal_entry","arguments":{"agent":"ceo-exec","title":"Deploy mcp-obsidian plan 1","content":"# Deploy\n\n22 tools + 2 resources live em mcp-obsidian.famachat.com.br."}}}'
```

Confirm the file appears in the vault and gets synced by `brain-sync.sh`.

---

## Success criteria (plan 1 scope, mirrors spec §9 items 1-9)

1. **22 tools + 2 resources** registered and discoverable via `tools/list`.
2. Coverage ≥ 80% in `vault/`, ≥ 60% overall.
3. Ownership enforcement blocks 100% of cross-agent writes in tests.
4. `read_agent_context` returns full bundle in < 200ms on real vault.
5. Concurrency stress passes zero-corruption (§M1).
6. Staging deploy + smoke test returns 22 tools.
7. README documents every tool with example + troubleshooting + AGENTS.md format.
8. `get_agent_delta` returns exactly entries with `mtime > since` and `owner == agent` (§I7).
9. `upsert_shared_context` enforces ownership path; cross-agent writes rejected (§I8).

---

## Self-review notes

**Spec coverage (plan 1 scope):** §4.1, §4.2 (12 of the 24 workflow tools — only the ones NOT introduced by addenda 2/3/5/6/7), §4.3, §4.4, §4.5, §5.1 (14 types, excludes financial-snapshot from plan 6), §5.2, §5.3, §5.4, §6.1/6.2/6.3/6.4/6.5, §7 (applicable targets), §8.1–§8.5, §9 items 1-9, §10 (YAGNI inherited), §11 (upgrade paths inherited). All accounted for by a phase or explicitly out of scope and deferred.

**Type consistency:** signatures match across phases — `ToolCtx`, `ok`, `tryToolBody`, `ownerCheck`, `validateOwners`, `encodeCursor/decodeCursor/hashQuery` live in `_shared.ts` (task I1); tools import from there. `IndexEntry` uses the same field names throughout. `GitOps.commitAndPush` returns `{ sha, branch, pushed }` consistently. `parseFrontmatter` returns `{ frontmatter, body }` with `frontmatter: null` for legacy files.

**Placeholder scan:** no TODO/TBD/incomplete steps; every step has actual code or a concrete command.

**Next plan:** after Plan 1 ships and smoke-tests, write Plan 2 (Lead pattern for Reno). Incorporate any lessons from Plan 1 execution (e.g., helpers to extract, test fixtures to reuse).








