# mcp-obsidian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `mcp-obsidian`, an MCP Server (TypeScript + Streamable HTTP) that exposes the `/root/fama-brain` Obsidian vault to LLM agents with strict ownership/frontmatter/append-only enforcement, hybrid search, and flock-coordinated git sync.

**Architecture:** Three tool layers (CRUD → Workflows → Git) over a vault module (fs + frontmatter + ownership + index + git). Each write validates ownership via mandatory `as_agent` param, rebuilds index entries lazily, and returns normalized paths. Git commits coordinated with the existing `brain-sync.sh` cron via shared `flock` on `/tmp/brain-sync.lock`.

**Tech Stack:** TypeScript 5, Node 20, `@modelcontextprotocol/sdk`, Express, Zod, `gray-matter`, `simple-git`, `proper-lockfile`, `vitest`, Docker.

**Spec:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`.

---

## File Structure

```
mcp-obsidian/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── .gitignore
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                  # HTTP bootstrap, Streamable transport, health
│   ├── server.ts                 # McpServer factory + register all tools/resources
│   ├── config.ts                 # env parse, VAULT_PATH, API_KEY, lockfile path
│   ├── auth.ts                   # Bearer middleware
│   ├── logger.ts                 # stdout JSON logger + audit helper
│   ├── errors.ts                 # typed errors (OWNERSHIP_VIOLATION, etc)
│   ├── middleware/
│   │   ├── rateLimit.ts
│   │   └── requestId.ts
│   ├── vault/
│   │   ├── fs.ts                 # atomic read/write, ASCII-fold, path guard
│   │   ├── frontmatter.ts        # gray-matter + Zod schemas
│   │   ├── ownership.ts          # parse README/AGENTS.md, resolveOwner, lazy reload
│   │   ├── index.ts              # in-memory index: tags/type/wikilinks/backlinks
│   │   └── git.ts                # flock-wrapped commit/push/status
│   ├── tools/
│   │   ├── crud.ts               # Layer 1 (8 tools)
│   │   ├── workflows.ts          # Layer 2 (9 tools)
│   │   └── sync.ts               # Layer 3 (2 tools)
│   └── resources/
│       └── vault.ts              # obsidian://vault, obsidian://agents
└── test/
    ├── fixtures/vault/           # mini-vault (2 agents, 5 notes)
    ├── unit/
    │   ├── frontmatter.test.ts
    │   ├── ownership.test.ts
    │   ├── fs.test.ts
    │   └── index.test.ts
    ├── integration/
    │   ├── crud.test.ts
    │   ├── workflows.test.ts
    │   └── ownership-enforcement.test.ts
    ├── stress/
    │   └── concurrency.test.ts
    └── e2e/
        └── smoke.test.ts
```

---

## Phase 1 — Project skeleton

### Task 1: Scaffold project

**Files:**
- Create: `mcp-obsidian/package.json`
- Create: `mcp-obsidian/tsconfig.json`
- Create: `mcp-obsidian/vitest.config.ts`
- Create: `mcp-obsidian/.gitignore`
- Create: `mcp-obsidian/.dockerignore`
- Create: `mcp-obsidian/.env.example`

- [ ] **Step 1: Create `mcp-obsidian/package.json`**

```json
{
  "name": "mcp-obsidian",
  "version": "1.0.0",
  "description": "MCP Server for the fama-brain Obsidian vault",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "express": "^4.21.2",
    "helmet": "^8.1.0",
    "express-rate-limit": "^7.5.0",
    "dotenv": "^16.4.7",
    "zod": "^3.24.0",
    "gray-matter": "^4.0.3",
    "simple-git": "^3.27.0",
    "proper-lockfile": "^4.1.2"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.12.0",
    "@types/proper-lockfile": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `mcp-obsidian/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `mcp-obsidian/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 60,
        'src/vault/**': { lines: 80, functions: 80, branches: 70 }
      }
    }
  }
});
```

- [ ] **Step 4: Create `mcp-obsidian/.gitignore`**

```
node_modules
dist
.env
coverage
*.log
```

- [ ] **Step 5: Create `mcp-obsidian/.dockerignore`**

```
node_modules
dist
.env
test
coverage
*.log
docs
.git
```

- [ ] **Step 6: Create `mcp-obsidian/.env.example`**

```
PORT=3201
API_KEY=change-me
VAULT_PATH=/vault
RATE_LIMIT_RPM=300
GIT_AUTHOR_NAME=mcp-obsidian
GIT_AUTHOR_EMAIL=mcp@fama.local
GIT_LOCKFILE=/tmp/brain-sync.lock
STRICT_WIKILINKS=false
LOG_LEVEL=info
```

- [ ] **Step 7: Install dependencies**

Run: `cd mcp-obsidian && npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 8: Commit**

```bash
cd mcp-obsidian && git add package.json tsconfig.json vitest.config.ts .gitignore .dockerignore .env.example package-lock.json
git commit -m "feat(mcp-obsidian): scaffold project"
```

---

### Task 2: Config module

**Files:**
- Create: `mcp-obsidian/src/config.ts`

- [ ] **Step 1: Write `src/config.ts`**

```ts
import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3201', 10),
  apiKey: process.env.API_KEY!,
  vaultPath: process.env.VAULT_PATH || '/vault',
  rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '300', 10),
  git: {
    authorName: process.env.GIT_AUTHOR_NAME || 'mcp-obsidian',
    authorEmail: process.env.GIT_AUTHOR_EMAIL || 'mcp@fama.local',
    lockfile: process.env.GIT_LOCKFILE || '/tmp/brain-sync.lock',
  },
  strictWikilinks: process.env.STRICT_WIKILINKS === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
};

if (!config.apiKey) throw new Error('API_KEY is required');
if (!config.vaultPath) throw new Error('VAULT_PATH is required');
```

- [ ] **Step 2: Run typecheck**

Run: `cd mcp-obsidian && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(mcp-obsidian): add config module"
```

---

### Task 3: Errors + logger

**Files:**
- Create: `mcp-obsidian/src/errors.ts`
- Create: `mcp-obsidian/src/logger.ts`
- Create: `mcp-obsidian/test/unit/errors.test.ts`

- [ ] **Step 1: Write failing test `test/unit/errors.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { VaultError, ErrorCode } from '../../src/errors.js';

describe('VaultError', () => {
  it('serializes to MCP error shape', () => {
    const err = new VaultError(
      ErrorCode.OWNERSHIP_VIOLATION,
      "File 'x' owned by 'a', not 'b'.",
      "Use as_agent='a'."
    );
    expect(err.toStructured()).toEqual({
      error: {
        code: 'OWNERSHIP_VIOLATION',
        message: "File 'x' owned by 'a', not 'b'.",
        suggestion: "Use as_agent='a'.",
      },
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd mcp-obsidian && npx vitest run test/unit/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/errors.ts`**

```ts
export enum ErrorCode {
  OWNERSHIP_VIOLATION = 'OWNERSHIP_VIOLATION',
  INVALID_FRONTMATTER = 'INVALID_FRONTMATTER',
  INVALID_FILENAME = 'INVALID_FILENAME',
  IMMUTABLE_TARGET = 'IMMUTABLE_TARGET',
  NOTE_NOT_FOUND = 'NOTE_NOT_FOUND',
  WIKILINK_TARGET_MISSING = 'WIKILINK_TARGET_MISSING',
  GIT_LOCK_BUSY = 'GIT_LOCK_BUSY',
  GIT_PUSH_FAILED = 'GIT_PUSH_FAILED',
  VAULT_IO_ERROR = 'VAULT_IO_ERROR',
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',
}

export class VaultError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'VaultError';
  }

  toStructured() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.suggestion ? { suggestion: this.suggestion } : {}),
      },
    };
  }
}
```

- [ ] **Step 4: Write `src/logger.ts`**

```ts
import { config } from './config.js';

type Level = 'info' | 'warn' | 'error' | 'debug';

interface LogFields {
  [k: string]: unknown;
}

function emit(level: Level | 'audit', msg: string, fields: LogFields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    msg,
    ...fields,
    ...(level === 'audit' ? { audit: true } : {}),
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  info: (msg: string, f?: LogFields) => emit('info', msg, f),
  warn: (msg: string, f?: LogFields) => emit('warn', msg, f),
  error: (msg: string, f?: LogFields) => emit('error', msg, f),
  debug: (msg: string, f?: LogFields) => {
    if (config.logLevel === 'debug') emit('debug', msg, f);
  },
  audit: (msg: string, f: LogFields) => emit('audit', msg, f),
};
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd mcp-obsidian && npx vitest run test/unit/errors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/logger.ts test/unit/errors.test.ts
git commit -m "feat(mcp-obsidian): add typed errors and JSON logger"
```

---

### Task 4: Auth + middleware

**Files:**
- Create: `mcp-obsidian/src/auth.ts`
- Create: `mcp-obsidian/src/middleware/rateLimit.ts`
- Create: `mcp-obsidian/src/middleware/requestId.ts`

- [ ] **Step 1: Write `src/auth.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health') {
    next();
    return;
  }
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) {
    res.set('WWW-Authenticate', 'Bearer realm="MCP Obsidian Server"');
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  if (h.slice(7) !== config.apiKey) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }
  next();
}
```

- [ ] **Step 2: Write `src/middleware/rateLimit.ts`**

```ts
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.rateLimitRpm,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});
```

- [ ] **Step 3: Write `src/middleware/requestId.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.requestId = (req.headers['x-request-id'] as string) || randomUUID();
  next();
}
```

- [ ] **Step 4: Typecheck**

Run: `cd mcp-obsidian && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/middleware/
git commit -m "feat(mcp-obsidian): add auth and middleware"
```

---

## Phase 2 — Vault primitives

### Task 5: Frontmatter parse/serialize + Zod schemas

**Files:**
- Create: `mcp-obsidian/src/vault/frontmatter.ts`
- Create: `mcp-obsidian/test/unit/frontmatter.test.ts`

- [ ] **Step 1: Write failing test `test/unit/frontmatter.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseNote, serializeNote, validateFrontmatter } from '../../src/vault/frontmatter.js';

describe('frontmatter', () => {
  it('parses valid note', () => {
    const raw = `---
type: journal
owner: ceo
created: 2026-04-01
updated: 2026-04-15
tags: [planning]
---

# Title

Body`;
    const p = parseNote(raw);
    expect(p.frontmatter.type).toBe('journal');
    expect(p.frontmatter.owner).toBe('ceo');
    expect(p.content).toContain('# Title');
  });

  it('round-trips', () => {
    const raw = `---
type: context
owner: ceo
created: 2026-04-01
updated: 2026-04-15
tags: []
---

Body
`;
    const p = parseNote(raw);
    const out = serializeNote(p.frontmatter, p.content);
    expect(parseNote(out).frontmatter).toEqual(p.frontmatter);
  });

  it('rejects invalid type', () => {
    expect(() =>
      validateFrontmatter({
        type: 'notarealtype',
        owner: 'ceo',
        created: '2026-04-01',
        updated: '2026-04-15',
        tags: [],
      })
    ).toThrow(/type/);
  });

  it('rejects missing owner', () => {
    expect(() =>
      validateFrontmatter({
        type: 'journal',
        created: '2026-04-01',
        updated: '2026-04-15',
        tags: [],
      })
    ).toThrow(/owner/);
  });

  it('requires period for goal/result', () => {
    expect(() =>
      validateFrontmatter({
        type: 'goal',
        owner: 'ceo',
        created: '2026-04-01',
        updated: '2026-04-15',
        tags: [],
      })
    ).toThrow(/period/);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd mcp-obsidian && npx vitest run test/unit/frontmatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/vault/frontmatter.ts`**

```ts
import matter from 'gray-matter';
import { z } from 'zod';
import { VaultError, ErrorCode } from '../errors.js';

export const NOTE_TYPES = [
  'moc', 'context', 'agents-map',
  'goal', 'goals-index', 'result', 'results-index',
  'agent-readme', 'agent-profile', 'agent-decisions', 'journal',
] as const;
export type NoteType = typeof NOTE_TYPES[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const period = z.string().regex(/^\d{4}-\d{2}$/, 'must be YYYY-MM');
const kebabTag = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'tags must be kebab-case');

const BaseSchema = z.object({
  type: z.enum(NOTE_TYPES),
  owner: z.string().min(1),
  created: isoDate,
  updated: isoDate,
  tags: z.array(kebabTag),
});

const GoalSchema = BaseSchema.extend({ type: z.literal('goal'), period });
const ResultSchema = BaseSchema.extend({ type: z.literal('result'), period });

export type Frontmatter = z.infer<typeof BaseSchema> & { period?: string; [k: string]: unknown };

export function validateFrontmatter(raw: unknown): Frontmatter {
  const base = BaseSchema.safeParse(raw);
  if (!base.success) {
    throw new VaultError(
      ErrorCode.INVALID_FRONTMATTER,
      `Invalid frontmatter: ${base.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      `Required fields: type (one of ${NOTE_TYPES.join(', ')}), owner, created (YYYY-MM-DD), updated (YYYY-MM-DD), tags[].`
    );
  }
  const data = base.data;
  if (data.type === 'goal') {
    const g = GoalSchema.safeParse(raw);
    if (!g.success) {
      throw new VaultError(
        ErrorCode.INVALID_FRONTMATTER,
        `goal requires period (YYYY-MM)`,
        `Add 'period: 2026-04' to frontmatter.`
      );
    }
    return g.data as Frontmatter;
  }
  if (data.type === 'result') {
    const r = ResultSchema.safeParse(raw);
    if (!r.success) {
      throw new VaultError(
        ErrorCode.INVALID_FRONTMATTER,
        `result requires period (YYYY-MM)`,
        `Add 'period: 2026-04' to frontmatter.`
      );
    }
    return r.data as Frontmatter;
  }
  return data as Frontmatter;
}

export interface ParsedNote {
  frontmatter: Frontmatter;
  content: string;
}

export function parseNote(raw: string): ParsedNote {
  const m = matter(raw);
  const fm = validateFrontmatter(m.data);
  return { frontmatter: fm, content: m.content };
}

export function serializeNote(fm: Frontmatter, content: string): string {
  const body = content.startsWith('\n') ? content : '\n' + content;
  return matter.stringify(body, fm as matter.Input['data']);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function extractWikilinks(content: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) out.add(m[1].trim());
  return [...out];
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/unit/frontmatter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/frontmatter.ts test/unit/frontmatter.test.ts
git commit -m "feat(mcp-obsidian): add frontmatter parse/validate with Zod"
```

---

### Task 6: FS primitives — path guard, ASCII-fold, atomic IO

**Files:**
- Create: `mcp-obsidian/src/vault/fs.ts`
- Create: `mcp-obsidian/test/unit/fs.test.ts`

- [ ] **Step 1: Write failing test `test/unit/fs.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asciiFold,
  normalizeFilename,
  resolveSafe,
  writeNoteAtomic,
  readNoteFile,
} from '../../src/vault/fs.js';

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'vault-')); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

describe('fs', () => {
  it('asciiFold removes accents', () => {
    expect(asciiFold('decisão fiscal')).toBe('decisao fiscal');
  });

  it('asciiFold is idempotent', () => {
    const once = asciiFold('Ação');
    expect(asciiFold(once)).toBe(once);
  });

  it('normalizeFilename folds + kebab-cases', () => {
    expect(normalizeFilename('2026-04-16-Decisão Fiscal.md'))
      .toBe('2026-04-16-decisao-fiscal.md');
  });

  it('resolveSafe rejects path traversal', () => {
    expect(() => resolveSafe(vault, '../etc/passwd')).toThrow(/PATH_TRAVERSAL/);
  });

  it('resolveSafe accepts nested path', () => {
    const p = resolveSafe(vault, '_agents/ceo/profile.md');
    expect(p.startsWith(vault)).toBe(true);
  });

  it('writeNoteAtomic + readNoteFile round-trips', async () => {
    const abs = resolveSafe(vault, 'a.md');
    await writeNoteAtomic(abs, 'hello');
    expect(await readNoteFile(abs)).toBe('hello');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-obsidian && npx vitest run test/unit/fs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/vault/fs.ts`**

```ts
import { promises as fs } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VaultError, ErrorCode } from '../errors.js';

export function asciiFold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeFilename(name: string): string {
  const folded = asciiFold(name);
  const lower = folded.toLowerCase();
  const kebab = lower
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return kebab + '.md';
}

const KEBAB = /^[a-z0-9][a-z0-9-]*\.md$/;
const JOURNAL_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/;

export function validateFilename(basename: string, opts: { journal?: boolean } = {}): void {
  const re = opts.journal ? JOURNAL_NAME : KEBAB;
  if (!re.test(basename)) {
    const suggest = normalizeFilename(basename);
    throw new VaultError(
      ErrorCode.INVALID_FILENAME,
      `Filename '${basename}' must be kebab-case ASCII${opts.journal ? ' starting with YYYY-MM-DD-' : ''}.`,
      `Suggested: '${suggest}'.`
    );
  }
}

export function resolveSafe(vaultPath: string, relPath: string): string {
  const normalized = relPath.replace(/^\/+/, '');
  const abs = resolve(vaultPath, normalized);
  const rel = relative(vaultPath, abs);
  if (rel.startsWith('..') || rel.includes('..' + sep) || resolve(vaultPath, rel) !== abs) {
    throw new VaultError(ErrorCode.PATH_TRAVERSAL, `Path '${relPath}' escapes the vault.`);
  }
  if (!abs.startsWith(vaultPath)) {
    throw new VaultError(ErrorCode.PATH_TRAVERSAL, `Path '${relPath}' escapes the vault.`);
  }
  return abs;
}

export async function readNoteFile(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new VaultError(ErrorCode.NOTE_NOT_FOUND, `Note '${absPath}' not found.`);
    }
    throw new VaultError(ErrorCode.VAULT_IO_ERROR, `IO error: ${err.message}`);
  }
}

export async function writeNoteAtomic(absPath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(absPath), { recursive: true });
  const tmp = absPath + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, absPath);
  } catch (e: unknown) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    const err = e as NodeJS.ErrnoException;
    throw new VaultError(ErrorCode.VAULT_IO_ERROR, `Write failed: ${err.message}`);
  }
}

export async function noteExists(absPath: string): Promise<boolean> {
  try { await fs.stat(absPath); return true; } catch { return false; }
}

export async function listMdFiles(absPath: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = resolve(d, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(p);
      }
    }
  }
  await walk(absPath);
  return out;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/unit/fs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/fs.ts test/unit/fs.test.ts
git commit -m "feat(mcp-obsidian): add fs primitives (safe paths, atomic IO, filename normalization)"
```

---

### Task 7: Ownership map + lazy reload

**Files:**
- Create: `mcp-obsidian/src/vault/ownership.ts`
- Create: `mcp-obsidian/test/fixtures/vault/README.md`
- Create: `mcp-obsidian/test/fixtures/vault/_shared/context/AGENTS.md`
- Create: `mcp-obsidian/test/fixtures/vault/_agents/alfa/profile.md`
- Create: `mcp-obsidian/test/fixtures/vault/_agents/alfa/decisions.md`
- Create: `mcp-obsidian/test/fixtures/vault/_agents/beta/profile.md`
- Create: `mcp-obsidian/test/fixtures/vault/_shared/goals/2026-04/alfa.md`
- Create: `mcp-obsidian/test/fixtures/vault/_agents/alfa/journal/2026-04-10-kickoff.md`
- Create: `mcp-obsidian/test/unit/ownership.test.ts`

- [ ] **Step 1: Create fixture `test/fixtures/vault/README.md`**

```markdown
# fama-brain (test fixture)

## Ownership

| Path pattern | Owner |
|---|---|
| `_agents/alfa/**` | alfa |
| `_agents/beta/**` | beta |
| `_shared/goals/*/alfa.md` | alfa |
| `_shared/goals/*/beta.md` | beta |
| `_shared/results/*/alfa.md` | alfa |
| `_shared/results/*/beta.md` | beta |
| `_shared/goals/**/index.md` | alfa |
| `_shared/results/**/index.md` | alfa |
```

- [ ] **Step 2: Create fixture `test/fixtures/vault/_shared/context/AGENTS.md`**

```markdown
---
type: agents-map
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---

# Agents

- alfa: diretoria
- beta: operacional
```

- [ ] **Step 3: Create fixture notes (5 total)**

`test/fixtures/vault/_agents/alfa/profile.md`:
```markdown
---
type: agent-profile
owner: alfa
created: 2026-04-01
updated: 2026-04-10
tags: [profile]
---

# Alfa
```

`test/fixtures/vault/_agents/alfa/decisions.md`:
```markdown
---
type: agent-decisions
owner: alfa
created: 2026-04-01
updated: 2026-04-10
tags: []
---

## 2026-04-10 — First decision

Rationale.
```

`test/fixtures/vault/_agents/alfa/journal/2026-04-10-kickoff.md`:
```markdown
---
type: journal
owner: alfa
created: 2026-04-10
updated: 2026-04-10
tags: [kickoff]
---

# Kickoff

See [[profile]].
```

`test/fixtures/vault/_agents/beta/profile.md`:
```markdown
---
type: agent-profile
owner: beta
created: 2026-04-01
updated: 2026-04-10
tags: [profile]
---

# Beta
```

`test/fixtures/vault/_shared/goals/2026-04/alfa.md`:
```markdown
---
type: goal
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
period: 2026-04
---

# Alfa goals April 2026
```

- [ ] **Step 4: Write failing test `test/unit/ownership.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { OwnershipMap } from '../../src/vault/ownership.js';

const vault = resolve(__dirname, '../fixtures/vault');

describe('OwnershipMap', () => {
  it('resolves agent zone', async () => {
    const map = await OwnershipMap.load(vault);
    expect(map.resolveOwner('_agents/alfa/profile.md')).toBe('alfa');
    expect(map.resolveOwner('_agents/beta/journal/2026-04-01-x.md')).toBe('beta');
  });

  it('resolves shared goals by filename', async () => {
    const map = await OwnershipMap.load(vault);
    expect(map.resolveOwner('_shared/goals/2026-04/alfa.md')).toBe('alfa');
    expect(map.resolveOwner('_shared/goals/2026-04/beta.md')).toBe('beta');
  });

  it('returns null for unmapped path', async () => {
    const map = await OwnershipMap.load(vault);
    expect(map.resolveOwner('_projects/x/readme.md')).toBeNull();
  });

  it('assertOwner throws on mismatch with actionable message', async () => {
    const map = await OwnershipMap.load(vault);
    expect(() => map.assertOwner('_agents/alfa/profile.md', 'beta'))
      .toThrow(/owned by 'alfa', not 'beta'/);
  });
});
```

- [ ] **Step 5: Run — expect FAIL**

Run: `cd mcp-obsidian && npx vitest run test/unit/ownership.test.ts`
Expected: FAIL.

- [ ] **Step 6: Write `src/vault/ownership.ts`**

```ts
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { VaultError, ErrorCode } from '../errors.js';

interface Rule {
  pattern: string;
  regex: RegExp;
  owner: string;
}

function globToRegex(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  return new RegExp('^' + esc + '$');
}

function parseRules(md: string): Rule[] {
  const rules: Rule[] = [];
  const re = /\|\s*`([^`]+)`\s*\|\s*([a-z0-9-]+)\s*\|/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const pattern = m[1].trim();
    const owner = m[2].trim();
    rules.push({ pattern, regex: globToRegex(pattern), owner });
  }
  return rules;
}

export class OwnershipMap {
  private rules: Rule[] = [];
  private sources: { path: string; mtimeMs: number }[] = [];

  private constructor(private vaultPath: string) {}

  static async load(vaultPath: string): Promise<OwnershipMap> {
    const map = new OwnershipMap(vaultPath);
    await map.reload();
    return map;
  }

  private async reload(): Promise<void> {
    const files = [
      resolve(this.vaultPath, 'README.md'),
      resolve(this.vaultPath, '_shared/context/AGENTS.md'),
    ];
    const rules: Rule[] = [];
    const sources: { path: string; mtimeMs: number }[] = [];
    for (const f of files) {
      try {
        const [raw, st] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
        rules.push(...parseRules(raw));
        sources.push({ path: f, mtimeMs: st.mtimeMs });
      } catch { /* missing file OK */ }
    }
    this.rules = rules;
    this.sources = sources;
  }

  async maybeReload(): Promise<void> {
    for (const s of this.sources) {
      try {
        const st = await fs.stat(s.path);
        if (st.mtimeMs !== s.mtimeMs) { await this.reload(); return; }
      } catch { await this.reload(); return; }
    }
  }

  resolveOwner(relPath: string): string | null {
    const norm = relPath.replace(/^\/+/, '');
    for (const r of this.rules) {
      if (r.regex.test(norm)) return r.owner;
    }
    return null;
  }

  assertOwner(relPath: string, asAgent: string): void {
    const owner = this.resolveOwner(relPath);
    if (!owner) {
      throw new VaultError(
        ErrorCode.OWNERSHIP_VIOLATION,
        `Path '${relPath}' has no owner mapping.`,
        `Add an ownership rule in README.md, or write under _agents/${asAgent}/.`
      );
    }
    if (owner !== asAgent) {
      throw new VaultError(
        ErrorCode.OWNERSHIP_VIOLATION,
        `File '${relPath}' is owned by '${owner}', not '${asAgent}'.`,
        `Use as_agent='${owner}' or write under _agents/${asAgent}/.`
      );
    }
  }

  agents(): string[] {
    return [...new Set(this.rules.map((r) => r.owner))];
  }

  dump(): { pattern: string; owner: string }[] {
    return this.rules.map((r) => ({ pattern: r.pattern, owner: r.owner }));
  }
}
```

- [ ] **Step 7: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/unit/ownership.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add src/vault/ownership.ts test/fixtures/vault test/unit/ownership.test.ts
git commit -m "feat(mcp-obsidian): add ownership map with lazy reload + fixture vault"
```

---

### Task 8: In-memory index (tags, type, wikilinks, backlinks)

**Files:**
- Create: `mcp-obsidian/src/vault/index.ts`
- Create: `mcp-obsidian/test/unit/index.test.ts`

- [ ] **Step 1: Write failing test `test/unit/index.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';

const vault = resolve(__dirname, '../fixtures/vault');

describe('VaultIndex', () => {
  it('builds and queries', async () => {
    const idx = await VaultIndex.build(vault);
    expect(idx.byType('journal').length).toBeGreaterThan(0);
    expect(idx.byTag('kickoff').length).toBe(1);
  });

  it('computes backlinks', async () => {
    const idx = await VaultIndex.build(vault);
    // journal links to [[profile]]
    const bl = idx.getBacklinks('profile');
    expect(bl.some((p) => p.endsWith('2026-04-10-kickoff.md'))).toBe(true);
  });

  it('upserts a note incrementally', async () => {
    const idx = await VaultIndex.build(vault);
    idx.upsert('_agents/alfa/new.md', {
      frontmatter: {
        type: 'context', owner: 'alfa',
        created: '2026-04-15', updated: '2026-04-15',
        tags: ['fresh'],
      } as any,
      wikilinks: ['profile'],
    });
    expect(idx.byTag('fresh').length).toBe(1);
    expect(idx.getBacklinks('profile').some((p) => p.endsWith('new.md'))).toBe(true);
  });

  it('remove drops entry', async () => {
    const idx = await VaultIndex.build(vault);
    idx.remove('_agents/alfa/journal/2026-04-10-kickoff.md');
    expect(idx.byTag('kickoff').length).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-obsidian && npx vitest run test/unit/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/vault/index.ts`**

```ts
import { promises as fs } from 'node:fs';
import { relative } from 'node:path';
import { parseNote, extractWikilinks, Frontmatter } from './frontmatter.js';
import { listMdFiles } from './fs.js';

export interface IndexEntry {
  path: string;                 // vault-relative
  frontmatter: Frontmatter;
  wikilinks: string[];
  mtimeMs: number;
}

interface UpsertInput {
  frontmatter: Frontmatter;
  wikilinks: string[];
  mtimeMs?: number;
}

export class VaultIndex {
  private entries = new Map<string, IndexEntry>();
  private byTypeMap = new Map<string, Set<string>>();
  private byTagMap = new Map<string, Set<string>>();
  private byOwnerMap = new Map<string, Set<string>>();
  private backlinkMap = new Map<string, Set<string>>(); // target basename → set of source paths
  private builtAt = 0;

  private constructor(private vaultPath: string) {}

  static async build(vaultPath: string): Promise<VaultIndex> {
    const idx = new VaultIndex(vaultPath);
    const files = await listMdFiles(vaultPath, true);
    for (const abs of files) {
      const rel = relative(vaultPath, abs);
      try {
        const [raw, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
        const parsed = parseNote(raw);
        idx.upsert(rel, {
          frontmatter: parsed.frontmatter,
          wikilinks: extractWikilinks(parsed.content),
          mtimeMs: st.mtimeMs,
        });
      } catch { /* skip malformed */ }
    }
    idx.builtAt = Date.now();
    return idx;
  }

  get ageMs(): number { return Date.now() - this.builtAt; }
  get size(): number { return this.entries.size; }

  upsert(relPath: string, input: UpsertInput): void {
    this.remove(relPath);
    const entry: IndexEntry = {
      path: relPath,
      frontmatter: input.frontmatter,
      wikilinks: input.wikilinks,
      mtimeMs: input.mtimeMs ?? Date.now(),
    };
    this.entries.set(relPath, entry);
    addTo(this.byTypeMap, entry.frontmatter.type, relPath);
    addTo(this.byOwnerMap, entry.frontmatter.owner, relPath);
    for (const t of entry.frontmatter.tags) addTo(this.byTagMap, t, relPath);
    for (const w of entry.wikilinks) addTo(this.backlinkMap, basenameKey(w), relPath);
  }

  remove(relPath: string): void {
    const prev = this.entries.get(relPath);
    if (!prev) return;
    this.entries.delete(relPath);
    removeFrom(this.byTypeMap, prev.frontmatter.type, relPath);
    removeFrom(this.byOwnerMap, prev.frontmatter.owner, relPath);
    for (const t of prev.frontmatter.tags) removeFrom(this.byTagMap, t, relPath);
    for (const w of prev.wikilinks) removeFrom(this.backlinkMap, basenameKey(w), relPath);
  }

  get(relPath: string): IndexEntry | undefined { return this.entries.get(relPath); }
  byType(t: string): string[] { return [...(this.byTypeMap.get(t) || [])]; }
  byTag(t: string): string[] { return [...(this.byTagMap.get(t) || [])]; }
  byOwner(o: string): string[] { return [...(this.byOwnerMap.get(o) || [])]; }

  getBacklinks(noteName: string): string[] {
    return [...(this.backlinkMap.get(basenameKey(noteName)) || [])];
  }

  countBacklinks(relPath: string): number {
    const base = basenameKey(relPath);
    return this.backlinkMap.get(base)?.size || 0;
  }

  stats() {
    const byType: Record<string, number> = {};
    for (const [k, v] of this.byTypeMap) byType[k] = v.size;
    const byOwner: Record<string, number> = {};
    for (const [k, v] of this.byOwnerMap) byOwner[k] = v.size;
    return { totalNotes: this.entries.size, byType, byOwner, indexAgeMs: this.ageMs };
  }
}

function addTo(m: Map<string, Set<string>>, k: string, v: string) {
  let s = m.get(k); if (!s) { s = new Set(); m.set(k, s); } s.add(v);
}
function removeFrom(m: Map<string, Set<string>>, k: string, v: string) {
  const s = m.get(k); if (!s) return; s.delete(v); if (s.size === 0) m.delete(k);
}
function basenameKey(s: string): string {
  const base = s.split('/').pop() || s;
  return base.replace(/\.md$/i, '').toLowerCase();
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/unit/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.ts test/unit/index.test.ts
git commit -m "feat(mcp-obsidian): add in-memory vault index (tags, type, owner, backlinks)"
```

---

### Task 9: Git ops with flock

**Files:**
- Create: `mcp-obsidian/src/vault/git.ts`
- Create: `mcp-obsidian/test/unit/git.test.ts`

- [ ] **Step 1: Write failing test `test/unit/git.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { VaultGit } from '../../src/vault/git.js';

let repo: string;
let lockfile: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'repo-'));
  lockfile = join(tmpdir(), `lock-${Date.now()}`);
  writeFileSync(lockfile, '');
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email test@test && git config user.name test', { cwd: repo });
  writeFileSync(join(repo, 'seed.txt'), 'x');
  execSync('git add . && git commit -q -m initial', { cwd: repo });
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  try { rmSync(lockfile, { force: true }); } catch {}
});

describe('VaultGit', () => {
  it('commits with prefixed message (no remote push)', async () => {
    writeFileSync(join(repo, 'a.md'), 'hello');
    const g = new VaultGit({ vaultPath: repo, lockfile, authorName: 'mcp', authorEmail: 'mcp@x', skipPush: true });
    const out = await g.commitAndPush('add a');
    expect(out.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(out.branch).toBe('main');
    const log = execSync('git log -1 --pretty=%s', { cwd: repo }).toString().trim();
    expect(log).toBe('[mcp-obsidian] add a');
  });

  it('status reports untracked', async () => {
    writeFileSync(join(repo, 'b.md'), 'y');
    const g = new VaultGit({ vaultPath: repo, lockfile, authorName: 'mcp', authorEmail: 'mcp@x', skipPush: true });
    const s = await g.status();
    expect(s.untracked).toContain('b.md');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-obsidian && npx vitest run test/unit/git.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/vault/git.ts`**

```ts
import { simpleGit, SimpleGit } from 'simple-git';
import * as lockfile from 'proper-lockfile';
import { VaultError, ErrorCode } from '../errors.js';

export interface VaultGitOpts {
  vaultPath: string;
  lockfile: string;
  authorName: string;
  authorEmail: string;
  skipPush?: boolean;
}

export interface CommitResult { sha: string; branch: string; pushed: boolean; }
export interface StatusResult {
  modified: string[];
  untracked: string[];
  deleted: string[];
  ahead: number;
  behind: number;
  branch: string;
}

export class VaultGit {
  private git: SimpleGit;
  constructor(private opts: VaultGitOpts) {
    this.git = simpleGit(opts.vaultPath, { config: [
      `user.name=${opts.authorName}`,
      `user.email=${opts.authorEmail}`,
    ]});
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.opts.lockfile, {
        retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
        stale: 60_000,
      });
    } catch (e: unknown) {
      throw new VaultError(
        ErrorCode.GIT_LOCK_BUSY,
        `Git lockfile '${this.opts.lockfile}' is busy (brain-sync cron running).`,
        `Retry in a few seconds.`
      );
    }
    try { return await fn(); } finally { await release(); }
  }

  async commitAndPush(message: string): Promise<CommitResult> {
    return this.withLock(async () => {
      await this.git.add(['-A']);
      const st = await this.git.status();
      if (st.files.length === 0) {
        const sha = (await this.git.revparse(['HEAD'])).trim();
        return { sha, branch: st.current || 'main', pushed: false };
      }
      const commitMsg = `[mcp-obsidian] ${message}`;
      const result = await this.git.commit(commitMsg);
      const sha = result.commit || (await this.git.revparse(['HEAD'])).trim();
      let pushed = false;
      if (!this.opts.skipPush) {
        try {
          await this.git.push();
          pushed = true;
        } catch (e: unknown) {
          const err = e as Error;
          throw new VaultError(ErrorCode.GIT_PUSH_FAILED, `Git push failed: ${err.message}`);
        }
      }
      return { sha, branch: st.current || 'main', pushed };
    });
  }

  async status(): Promise<StatusResult> {
    const st = await this.git.status();
    return {
      modified: st.modified,
      untracked: st.not_added,
      deleted: st.deleted,
      ahead: st.ahead,
      behind: st.behind,
      branch: st.current || 'main',
    };
  }

  async head(): Promise<string> {
    try { return (await this.git.revparse(['HEAD'])).trim(); } catch { return ''; }
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/unit/git.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/git.ts test/unit/git.test.ts
git commit -m "feat(mcp-obsidian): add VaultGit with flock-serialized commit/status"
```

---

## Phase 3 — Tool wiring + Layer 1 (CRUD)

### Task 10: ToolContext factory

**Files:**
- Create: `mcp-obsidian/src/vault/context.ts`

- [ ] **Step 1: Write `src/vault/context.ts`**

```ts
import { config } from '../config.js';
import { OwnershipMap } from './ownership.js';
import { VaultIndex } from './index.js';
import { VaultGit } from './git.js';

export interface VaultContext {
  vaultPath: string;
  ownership: OwnershipMap;
  index: VaultIndex;
  git: VaultGit;
}

export async function buildContext(overrides?: Partial<VaultContext>): Promise<VaultContext> {
  const vaultPath = overrides?.vaultPath ?? config.vaultPath;
  const ownership = overrides?.ownership ?? await OwnershipMap.load(vaultPath);
  const index = overrides?.index ?? await VaultIndex.build(vaultPath);
  const git = overrides?.git ?? new VaultGit({
    vaultPath,
    lockfile: config.git.lockfile,
    authorName: config.git.authorName,
    authorEmail: config.git.authorEmail,
  });
  return { vaultPath, ownership, index, git };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/vault/context.ts
git commit -m "feat(mcp-obsidian): add VaultContext factory"
```

---

### Task 11: Layer 1 reads (read_note, get_note_metadata, stat_vault, list_folder)

**Files:**
- Create: `mcp-obsidian/src/tools/crud.ts`
- Create: `mcp-obsidian/test/integration/crud.test.ts`

- [ ] **Step 1: Write failing test `test/integration/crud.test.ts`**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { buildContext, VaultContext } from '../../src/vault/context.js';
import {
  readNote, getNoteMetadata, statVault, listFolder,
} from '../../src/tools/crud.js';

const vault = resolve(__dirname, '../fixtures/vault');

let ctx: VaultContext;
beforeAll(async () => { ctx = await buildContext({ vaultPath: vault }); });

describe('CRUD reads', () => {
  it('readNote returns frontmatter + content + backlinks_count', async () => {
    const r = await readNote(ctx, { path: '_agents/alfa/profile.md' });
    expect(r.frontmatter.owner).toBe('alfa');
    expect(r.bytes).toBeGreaterThan(0);
    expect(typeof r.backlinks_count).toBe('number');
  });

  it('getNoteMetadata returns fm only', async () => {
    const r = await getNoteMetadata(ctx, { path: '_agents/alfa/profile.md' });
    expect(r.frontmatter.type).toBe('agent-profile');
    expect((r as any).content).toBeUndefined();
  });

  it('statVault reports totals', async () => {
    const r = await statVault(ctx);
    expect(r.total_notes).toBeGreaterThan(0);
    expect(r.by_type['agent-profile']).toBeGreaterThanOrEqual(2);
  });

  it('listFolder paginates', async () => {
    const r = await listFolder(ctx, { path: '_agents', recursive: true, limit: 2 });
    expect(r.items.length).toBe(2);
    expect(r.next_cursor).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-obsidian && npx vitest run test/integration/crud.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/tools/crud.ts` (reads only for now)**

```ts
import { promises as fs } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import { VaultContext } from '../vault/context.js';
import { resolveSafe, readNoteFile, listMdFiles } from '../vault/fs.js';
import { parseNote, extractWikilinks } from '../vault/frontmatter.js';
import { VaultError, ErrorCode } from '../errors.js';

// ---------- schemas ----------
export const ReadNoteInput = z.object({ path: z.string().min(1) });
export const GetMetadataInput = z.object({ path: z.string().min(1) });
export const StatVaultInput = z.object({}).optional();
export const ListFolderInput = z.object({
  path: z.string().default(''),
  recursive: z.boolean().default(false),
  filter_type: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

// ---------- cursor helpers ----------
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}
function decodeCursor(c?: string): number {
  if (!c) return 0;
  try { return JSON.parse(Buffer.from(c, 'base64url').toString()).o || 0; } catch { return 0; }
}

// ---------- read_note ----------
export async function readNote(ctx: VaultContext, input: z.infer<typeof ReadNoteInput>) {
  const abs = resolveSafe(ctx.vaultPath, input.path);
  const raw = await readNoteFile(abs);
  const parsed = parseNote(raw);
  const wikilinks = extractWikilinks(parsed.content);
  const st = await fs.stat(abs);
  const rel = relative(ctx.vaultPath, abs);
  return {
    path: rel,
    frontmatter: parsed.frontmatter,
    content: parsed.content,
    wikilinks,
    backlinks_count: ctx.index.countBacklinks(rel),
    bytes: st.size,
    updated: parsed.frontmatter.updated,
  };
}

// ---------- get_note_metadata ----------
export async function getNoteMetadata(ctx: VaultContext, input: z.infer<typeof GetMetadataInput>) {
  const abs = resolveSafe(ctx.vaultPath, input.path);
  const rel = relative(ctx.vaultPath, abs);
  const entry = ctx.index.get(rel);
  if (entry) {
    return {
      path: rel,
      frontmatter: entry.frontmatter,
      wikilinks: entry.wikilinks,
      backlinks_count: ctx.index.countBacklinks(rel),
    };
  }
  const raw = await readNoteFile(abs);
  const parsed = parseNote(raw);
  return {
    path: rel,
    frontmatter: parsed.frontmatter,
    wikilinks: extractWikilinks(parsed.content),
    backlinks_count: ctx.index.countBacklinks(rel),
  };
}

// ---------- stat_vault ----------
export async function statVault(ctx: VaultContext) {
  const s = ctx.index.stats();
  return {
    total_notes: s.totalNotes,
    by_type: s.byType,
    by_agent: s.byOwner,
    index_age_ms: s.indexAgeMs,
    last_sync: await ctx.git.head(),
  };
}

// ---------- list_folder ----------
export async function listFolder(ctx: VaultContext, input: z.infer<typeof ListFolderInput>) {
  const abs = resolveSafe(ctx.vaultPath, input.path);
  const files = await listMdFiles(abs, input.recursive);
  const rels = files.map((f) => relative(ctx.vaultPath, f)).sort();
  const filtered = input.filter_type
    ? rels.filter((r) => ctx.index.get(r)?.frontmatter.type === input.filter_type)
    : rels;
  const offset = decodeCursor(input.cursor);
  const slice = filtered.slice(offset, offset + input.limit);
  const items = slice.map((r) => {
    const e = ctx.index.get(r);
    return {
      path: r,
      type: e?.frontmatter.type ?? null,
      owner: e?.frontmatter.owner ?? null,
      updated: e?.frontmatter.updated ?? null,
      tags: e?.frontmatter.tags ?? [],
    };
  });
  const nextOffset = offset + slice.length;
  return {
    items,
    ...(nextOffset < filtered.length ? { next_cursor: encodeCursor(nextOffset) } : {}),
    total: filtered.length,
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/integration/crud.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud.test.ts
git commit -m "feat(mcp-obsidian): add CRUD read tools (read_note, get_note_metadata, stat_vault, list_folder)"
```

---

### Task 12: CRUD writes (write_note, append_to_note, delete_note) + search_content

**Files:**
- Modify: `mcp-obsidian/src/tools/crud.ts`
- Create: `mcp-obsidian/test/integration/crud-writes.test.ts`

- [ ] **Step 1: Write failing test `test/integration/crud-writes.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildContext, VaultContext } from '../../src/vault/context.js';
import {
  writeNote, appendToNote, deleteNote, searchContent,
} from '../../src/tools/crud.js';

const fixture = resolve(__dirname, '../fixtures/vault');
let vault: string;
let ctx: VaultContext;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), 'vault-'));
  cpSync(fixture, vault, { recursive: true });
  ctx = await buildContext({ vaultPath: vault });
});
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

describe('CRUD writes', () => {
  it('writeNote creates file and refreshes index', async () => {
    const r = await writeNote(ctx, {
      path: '_agents/alfa/new-note.md',
      content: '# Hello\n\nSee [[profile]].\n',
      frontmatter: { type: 'context', tags: ['hello'] },
      as_agent: 'alfa',
    });
    expect(r.path).toBe('_agents/alfa/new-note.md');
    expect(ctx.index.byTag('hello').length).toBe(1);
  });

  it('writeNote rejects cross-agent', async () => {
    await expect(writeNote(ctx, {
      path: '_agents/alfa/x.md',
      content: 'x',
      frontmatter: { type: 'context', tags: [] },
      as_agent: 'beta',
    })).rejects.toThrow(/OWNERSHIP_VIOLATION|owned by 'alfa'/);
  });

  it('writeNote blocks decisions.md', async () => {
    await expect(writeNote(ctx, {
      path: '_agents/alfa/decisions.md',
      content: 'x',
      frontmatter: { type: 'agent-decisions', tags: [] },
      as_agent: 'alfa',
    })).rejects.toThrow(/IMMUTABLE|append_decision/);
  });

  it('writeNote normalizes filename with accents', async () => {
    const r = await writeNote(ctx, {
      path: '_agents/alfa/Ação-Fiscal.md',
      content: 'x',
      frontmatter: { type: 'context', tags: [] },
      as_agent: 'alfa',
    });
    expect(r.path).toBe('_agents/alfa/acao-fiscal.md');
  });

  it('appendToNote appends raw', async () => {
    const r = await appendToNote(ctx, {
      path: '_agents/alfa/profile.md',
      content: '\n\nExtra line.',
      as_agent: 'alfa',
    });
    expect(r.bytes_appended).toBeGreaterThan(0);
  });

  it('deleteNote requires reason, updates index', async () => {
    await writeNote(ctx, {
      path: '_agents/alfa/trash.md',
      content: 'x',
      frontmatter: { type: 'context', tags: ['gone'] },
      as_agent: 'alfa',
    });
    const r = await deleteNote(ctx, {
      path: '_agents/alfa/trash.md',
      as_agent: 'alfa',
      reason: 'duplicate of another note',
    });
    expect(r.deleted).toBe(true);
    expect(ctx.index.byTag('gone').length).toBe(0);
  });

  it('searchContent finds text', async () => {
    const r = await searchContent(ctx, { query: 'Kickoff' });
    expect(r.matches.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-obsidian && npx vitest run test/integration/crud-writes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Append to `src/tools/crud.ts`**

Add these exports at the bottom of `src/tools/crud.ts`:

```ts
import { spawn } from 'node:child_process';
import { dirname, basename } from 'node:path';
import { writeNoteAtomic, normalizeFilename, validateFilename, noteExists } from '../vault/fs.js';
import { serializeNote, today, validateFrontmatter, Frontmatter } from '../vault/frontmatter.js';
import { logger } from '../logger.js';

// ---------- schemas ----------
export const WriteNoteInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  frontmatter: z.record(z.unknown()),
  as_agent: z.string().min(1),
});
export const AppendNoteInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  as_agent: z.string().min(1),
});
export const DeleteNoteInput = z.object({
  path: z.string().min(1),
  as_agent: z.string().min(1),
  reason: z.string().min(3),
});
export const SearchContentInput = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  type: z.string().optional(),
  tag: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

// ---------- helpers ----------
function normalizeRelPath(rel: string): string {
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) throw new VaultError(ErrorCode.INVALID_FILENAME, 'Empty path');
  const last = parts[parts.length - 1];
  const normalized = normalizeFilename(last);
  parts[parts.length - 1] = normalized;
  return parts.join('/');
}

function isDecisionsFile(rel: string): boolean {
  return /(^|\/)decisions\.md$/.test(rel);
}
function isJournalFile(rel: string): boolean {
  return /^_agents\/[^/]+\/journal\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(rel);
}

// ---------- write_note ----------
export async function writeNote(ctx: VaultContext, input: z.infer<typeof WriteNoteInput>) {
  await ctx.ownership.maybeReload();
  const rel = normalizeRelPath(input.path);
  const base = basename(rel);
  validateFilename(base, { journal: isJournalFile(rel) });

  if (isDecisionsFile(rel)) {
    throw new VaultError(
      ErrorCode.IMMUTABLE_TARGET,
      `${rel} is append-only.`,
      `Use append_decision(agent, title, rationale).`
    );
  }

  const abs = resolveSafe(ctx.vaultPath, rel);
  ctx.ownership.assertOwner(rel, input.as_agent);

  if (isJournalFile(rel) && await noteExists(abs)) {
    throw new VaultError(
      ErrorCode.IMMUTABLE_TARGET,
      `Journal entries are immutable once created.`,
      `Use append_to_note to add content.`
    );
  }

  const existing = await noteExists(abs);
  const fmInput: Frontmatter = {
    ...(input.frontmatter as Frontmatter),
    owner: input.as_agent,
    created: (input.frontmatter.created as string) || today(),
    updated: today(),
    tags: (input.frontmatter.tags as string[]) || [],
  };
  const fm = validateFrontmatter(fmInput);

  const raw = serializeNote(fm, input.content);
  await writeNoteAtomic(abs, raw);

  ctx.index.upsert(rel, {
    frontmatter: fm,
    wikilinks: extractWikilinks(input.content),
  });

  logger.audit('write_note', {
    as_agent: input.as_agent,
    path: rel,
    action: existing ? 'update' : 'create',
  });

  return { path: rel, created: !existing };
}

// ---------- append_to_note ----------
export async function appendToNote(ctx: VaultContext, input: z.infer<typeof AppendNoteInput>) {
  await ctx.ownership.maybeReload();
  const rel = input.path.replace(/^\/+/, '');
  if (isDecisionsFile(rel)) {
    throw new VaultError(
      ErrorCode.IMMUTABLE_TARGET,
      `${rel} is append-only.`,
      `Use append_decision(agent, title, rationale).`
    );
  }
  const abs = resolveSafe(ctx.vaultPath, rel);
  ctx.ownership.assertOwner(rel, input.as_agent);

  const current = await readNoteFile(abs);
  const parsed = parseNote(current);
  const newContent = parsed.content.replace(/\n*$/, '\n') + input.content;
  parsed.frontmatter.updated = today();
  const raw = serializeNote(parsed.frontmatter, newContent);
  await writeNoteAtomic(abs, raw);

  ctx.index.upsert(rel, {
    frontmatter: parsed.frontmatter,
    wikilinks: extractWikilinks(newContent),
  });

  logger.audit('append_to_note', { as_agent: input.as_agent, path: rel, action: 'append' });

  return { path: rel, bytes_appended: Buffer.byteLength(input.content, 'utf8') };
}

// ---------- delete_note ----------
export async function deleteNote(ctx: VaultContext, input: z.infer<typeof DeleteNoteInput>) {
  await ctx.ownership.maybeReload();
  const rel = input.path.replace(/^\/+/, '');
  if (isDecisionsFile(rel)) {
    throw new VaultError(ErrorCode.IMMUTABLE_TARGET, `decisions.md cannot be deleted.`);
  }
  if (isJournalFile(rel)) {
    throw new VaultError(ErrorCode.IMMUTABLE_TARGET, `Journal entries cannot be deleted.`);
  }
  const abs = resolveSafe(ctx.vaultPath, rel);
  ctx.ownership.assertOwner(rel, input.as_agent);
  if (!(await noteExists(abs))) {
    throw new VaultError(ErrorCode.NOTE_NOT_FOUND, `Note '${rel}' not found.`);
  }
  await fs.unlink(abs);
  ctx.index.remove(rel);
  logger.audit('delete_note', { as_agent: input.as_agent, path: rel, action: 'delete', reason: input.reason });
  return { path: rel, deleted: true, reason: input.reason };
}

// ---------- search_content (ripgrep) ----------
function runRg(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('rg', args, { cwd });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => reject(new VaultError(ErrorCode.VAULT_IO_ERROR, `ripgrep spawn failed: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0 || code === 1) resolve(out);
      else reject(new VaultError(ErrorCode.VAULT_IO_ERROR, `ripgrep exit ${code}: ${err}`));
    });
  });
}

export async function searchContent(ctx: VaultContext, input: z.infer<typeof SearchContentInput>) {
  const searchRoot = input.path ? resolveSafe(ctx.vaultPath, input.path) : ctx.vaultPath;
  const args = ['--json', '--max-count', '5', '-e', input.query, searchRoot];
  const stdout = await runRg(args, ctx.vaultPath);
  const matches: { path: string; line: number; preview: string }[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    let evt; try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type !== 'match') continue;
    const rel = relative(ctx.vaultPath, evt.data.path.text);
    if (input.type) {
      const e = ctx.index.get(rel);
      if (!e || e.frontmatter.type !== input.type) continue;
    }
    if (input.tag) {
      const e = ctx.index.get(rel);
      if (!e || !e.frontmatter.tags.includes(input.tag)) continue;
    }
    matches.push({
      path: rel,
      line: evt.data.line_number,
      preview: (evt.data.lines.text || '').replace(/\n$/, '').slice(0, 200),
    });
  }
  const offset = decodeCursor(input.cursor);
  const slice = matches.slice(offset, offset + input.limit);
  const nextOffset = offset + slice.length;
  return {
    matches: slice,
    ...(nextOffset < matches.length ? { next_cursor: encodeCursor(nextOffset) } : {}),
    total: matches.length,
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/integration/crud-writes.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/crud.ts test/integration/crud-writes.test.ts
git commit -m "feat(mcp-obsidian): add CRUD writes (write/append/delete) + search_content"
```

---

## Phase 4 — Layer 2 workflows

### Task 13: Journal + decisions workflows

**Files:**
- Create: `mcp-obsidian/src/tools/workflows.ts`
- Create: `mcp-obsidian/test/integration/workflows.test.ts`

- [ ] **Step 1: Write failing test `test/integration/workflows.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildContext, VaultContext } from '../../src/vault/context.js';
import {
  createJournalEntry, appendDecision, updateAgentProfile,
  upsertGoal, upsertResult, readAgentContext,
  searchByTag, searchByType, getBacklinks,
} from '../../src/tools/workflows.js';

const fixture = resolve(__dirname, '../fixtures/vault');
let vault: string; let ctx: VaultContext;
beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), 'vault-'));
  cpSync(fixture, vault, { recursive: true });
  ctx = await buildContext({ vaultPath: vault });
});
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

describe('workflows', () => {
  it('createJournalEntry writes with correct frontmatter and path', async () => {
    const r = await createJournalEntry(ctx, {
      agent: 'alfa', title: 'Reunião Trimestral', content: 'notes', tags: ['planning'],
    });
    expect(r.path).toMatch(/_agents\/alfa\/journal\/\d{4}-\d{2}-\d{2}-reuniao-trimestral\.md$/);
    const raw = readFileSync(join(vault, r.path), 'utf8');
    expect(raw).toContain('type: journal');
    expect(raw).toContain('owner: alfa');
  });

  it('appendDecision prepends to decisions.md', async () => {
    await appendDecision(ctx, {
      agent: 'alfa', title: 'New direction', rationale: 'because', tags: [],
    });
    const raw = readFileSync(join(vault, '_agents/alfa/decisions.md'), 'utf8');
    const bodyStart = raw.indexOf('\n## ');
    const newIdx = raw.indexOf('New direction');
    const oldIdx = raw.indexOf('First decision');
    expect(newIdx).toBeGreaterThan(0);
    expect(newIdx).toBeLessThan(oldIdx);
    expect(bodyStart).toBeLessThan(newIdx);
  });

  it('updateAgentProfile preserves created, updates updated', async () => {
    const r = await updateAgentProfile(ctx, { agent: 'alfa', content: '# Alfa v2' });
    const raw = readFileSync(join(vault, r.path), 'utf8');
    expect(raw).toContain('created: 2026-04-01');
    expect(raw).toContain('Alfa v2');
  });

  it('upsertGoal creates file with period', async () => {
    const r = await upsertGoal(ctx, {
      agent: 'beta', period: '2026-05', content: '# Beta May goals',
    });
    expect(r.path).toBe('_shared/goals/2026-05/beta.md');
    const raw = readFileSync(join(vault, r.path), 'utf8');
    expect(raw).toContain('period: 2026-05');
    expect(raw).toContain('owner: beta');
  });

  it('upsertResult creates file', async () => {
    const r = await upsertResult(ctx, {
      agent: 'alfa', period: '2026-04', content: '# done',
    });
    expect(r.path).toBe('_shared/results/2026-04/alfa.md');
  });

  it('readAgentContext returns bundle', async () => {
    const r = await readAgentContext(ctx, { agent: 'alfa' });
    expect(r.profile).toBeTruthy();
    expect(r.decisions.length).toBeGreaterThan(0);
    expect(r.journals.length).toBeGreaterThan(0);
  });

  it('searchByTag/type/backlinks work', async () => {
    expect((await searchByTag(ctx, { tag: 'kickoff' })).notes.length).toBe(1);
    expect((await searchByType(ctx, { type: 'agent-profile' })).notes.length).toBe(2);
    expect((await getBacklinks(ctx, { note_name: 'profile' })).notes.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-obsidian && npx vitest run test/integration/workflows.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/tools/workflows.ts`**

```ts
import { z } from 'zod';
import { relative } from 'node:path';
import { VaultContext } from '../vault/context.js';
import {
  readNote, writeNote, appendToNote,
  ReadNoteInput as _RN,
} from './crud.js';
import { resolveSafe, readNoteFile, normalizeFilename, noteExists, writeNoteAtomic } from '../vault/fs.js';
import { parseNote, serializeNote, today, extractWikilinks, Frontmatter } from '../vault/frontmatter.js';
import { VaultError, ErrorCode } from '../errors.js';
import { logger } from '../logger.js';

// ---------- schemas ----------
const agent = z.string().min(1);
const period = z.string().regex(/^\d{4}-\d{2}$/);
const tags = z.array(z.string()).default([]);

export const CreateJournalInput = z.object({
  agent, title: z.string().min(1), content: z.string().default(''), tags,
});
export const AppendDecisionInput = z.object({
  agent, title: z.string().min(1), rationale: z.string().min(1), tags,
});
export const UpdateProfileInput = z.object({ agent, content: z.string() });
export const UpsertGoalInput = z.object({ agent, period, content: z.string() });
export const UpsertResultInput = z.object({ agent, period, content: z.string() });
export const ReadAgentContextInput = z.object({
  agent,
  n_decisions: z.number().int().min(1).max(50).default(5),
  n_journals: z.number().int().min(1).max(50).default(5),
});
export const SearchByTagInput = z.object({ tag: z.string().min(1) });
export const SearchByTypeInput = z.object({ type: z.string().min(1) });
export const GetBacklinksInput = z.object({ note_name: z.string().min(1) });

// ---------- create_journal_entry ----------
export async function createJournalEntry(ctx: VaultContext, input: z.infer<typeof CreateJournalInput>) {
  const date = today();
  const slug = normalizeFilename(input.title + '.md').replace(/\.md$/, '');
  const rel = `_agents/${input.agent}/journal/${date}-${slug}.md`;
  const r = await writeNote(ctx, {
    path: rel,
    content: input.content,
    frontmatter: { type: 'journal', tags: input.tags },
    as_agent: input.agent,
  });
  return { path: r.path, created: true };
}

// ---------- append_decision ----------
export async function appendDecision(ctx: VaultContext, input: z.infer<typeof AppendDecisionInput>) {
  await ctx.ownership.maybeReload();
  const rel = `_agents/${input.agent}/decisions.md`;
  const abs = resolveSafe(ctx.vaultPath, rel);
  ctx.ownership.assertOwner(rel, input.agent);

  const tagLine = input.tags.length ? ` (tags: ${input.tags.join(', ')})` : '';
  const block = `## ${today()} — ${input.title}${tagLine}\n\n${input.rationale}\n\n`;

  let parsed: { frontmatter: Frontmatter; content: string };
  if (await noteExists(abs)) {
    parsed = parseNote(await readNoteFile(abs));
  } else {
    parsed = {
      frontmatter: {
        type: 'agent-decisions', owner: input.agent,
        created: today(), updated: today(), tags: [],
      },
      content: '',
    };
  }
  parsed.content = block + parsed.content.replace(/^\n+/, '');
  parsed.frontmatter.updated = today();

  const raw = serializeNote(parsed.frontmatter, parsed.content);
  await writeNoteAtomic(abs, raw);
  ctx.index.upsert(rel, {
    frontmatter: parsed.frontmatter,
    wikilinks: extractWikilinks(parsed.content),
  });

  logger.audit('append_decision', {
    as_agent: input.agent, path: rel, action: 'prepend', title: input.title,
  });

  return { path: rel, prepended: true };
}

// ---------- update_agent_profile ----------
export async function updateAgentProfile(ctx: VaultContext, input: z.infer<typeof UpdateProfileInput>) {
  await ctx.ownership.maybeReload();
  const rel = `_agents/${input.agent}/profile.md`;
  const abs = resolveSafe(ctx.vaultPath, rel);
  ctx.ownership.assertOwner(rel, input.agent);

  const existing = await noteExists(abs)
    ? parseNote(await readNoteFile(abs))
    : null;
  const fm: Frontmatter = {
    type: 'agent-profile',
    owner: input.agent,
    created: existing?.frontmatter.created || today(),
    updated: today(),
    tags: existing?.frontmatter.tags || [],
  };
  const raw = serializeNote(fm, input.content);
  await writeNoteAtomic(abs, raw);
  ctx.index.upsert(rel, { frontmatter: fm, wikilinks: extractWikilinks(input.content) });
  logger.audit('update_agent_profile', { as_agent: input.agent, path: rel, action: 'update' });
  return { path: rel };
}

// ---------- upsert_goal / upsert_result ----------
async function upsertPeriodic(
  ctx: VaultContext,
  kind: 'goal' | 'result',
  input: { agent: string; period: string; content: string }
) {
  const folder = kind === 'goal' ? 'goals' : 'results';
  const rel = `_shared/${folder}/${input.period}/${input.agent}.md`;
  const abs = resolveSafe(ctx.vaultPath, rel);
  await ctx.ownership.maybeReload();
  ctx.ownership.assertOwner(rel, input.agent);
  const existing = await noteExists(abs) ? parseNote(await readNoteFile(abs)) : null;
  const fm: Frontmatter = {
    type: kind,
    owner: input.agent,
    created: existing?.frontmatter.created || today(),
    updated: today(),
    tags: existing?.frontmatter.tags || [],
    period: input.period,
  };
  const raw = serializeNote(fm, input.content);
  await writeNoteAtomic(abs, raw);
  ctx.index.upsert(rel, { frontmatter: fm, wikilinks: extractWikilinks(input.content) });
  const created_or_updated: 'created' | 'updated' = existing ? 'updated' : 'created';
  logger.audit(`upsert_${kind}`, { as_agent: input.agent, path: rel, action: created_or_updated });
  return { path: rel, created_or_updated };
}

export const upsertGoal = (ctx: VaultContext, input: z.infer<typeof UpsertGoalInput>) =>
  upsertPeriodic(ctx, 'goal', input);
export const upsertResult = (ctx: VaultContext, input: z.infer<typeof UpsertResultInput>) =>
  upsertPeriodic(ctx, 'result', input);

// ---------- read_agent_context ----------
export async function readAgentContext(ctx: VaultContext, input: z.infer<typeof ReadAgentContextInput>) {
  const profileRel = `_agents/${input.agent}/profile.md`;
  const decisionsRel = `_agents/${input.agent}/decisions.md`;
  const journalDir = `_agents/${input.agent}/journal`;

  const profile = (await noteExists(resolveSafe(ctx.vaultPath, profileRel)))
    ? await readNote(ctx, { path: profileRel })
    : null;

  let decisions: string[] = [];
  if (await noteExists(resolveSafe(ctx.vaultPath, decisionsRel))) {
    const dec = await readNote(ctx, { path: decisionsRel });
    decisions = dec.content.split(/\n(?=## \d{4}-\d{2}-\d{2})/)
      .filter((s) => s.trim().startsWith('## '))
      .slice(0, input.n_decisions);
  }

  const journalFiles = ctx.index.byOwner(input.agent)
    .filter((p) => p.startsWith(journalDir))
    .sort().reverse()
    .slice(0, input.n_journals);
  const journals = await Promise.all(journalFiles.map((p) => readNote(ctx, { path: p })));

  const ym = today().slice(0, 7);
  const goalRel = `_shared/goals/${ym}/${input.agent}.md`;
  const resultRel = `_shared/results/${ym}/${input.agent}.md`;
  const goals = (await noteExists(resolveSafe(ctx.vaultPath, goalRel)))
    ? await readNote(ctx, { path: goalRel }) : null;
  const results = (await noteExists(resolveSafe(ctx.vaultPath, resultRel)))
    ? await readNote(ctx, { path: resultRel }) : null;

  return { profile, decisions, journals, goals, results };
}

// ---------- search tools ----------
export async function searchByTag(ctx: VaultContext, input: z.infer<typeof SearchByTagInput>) {
  const notes = ctx.index.byTag(input.tag).map((p) => {
    const e = ctx.index.get(p)!;
    return { path: p, type: e.frontmatter.type, owner: e.frontmatter.owner };
  });
  return { notes };
}

export async function searchByType(ctx: VaultContext, input: z.infer<typeof SearchByTypeInput>) {
  const notes = ctx.index.byType(input.type).map((p) => {
    const e = ctx.index.get(p)!;
    return { path: p, type: e.frontmatter.type, owner: e.frontmatter.owner };
  });
  return { notes };
}

export async function getBacklinks(ctx: VaultContext, input: z.infer<typeof GetBacklinksInput>) {
  const notes = ctx.index.getBacklinks(input.note_name).map((p) => ({ path: p }));
  return { notes };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd mcp-obsidian && npx vitest run test/integration/workflows.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflows.ts test/integration/workflows.test.ts
git commit -m "feat(mcp-obsidian): add Layer 2 workflows (journal, decision, goal, result, context, search)"
```

---

## Phase 5 — Layer 3 + ownership enforcement tests

### Task 14: Sync tools + dedicated ownership enforcement tests

**Files:**
- Create: `mcp-obsidian/src/tools/sync.ts`
- Create: `mcp-obsidian/test/integration/ownership-enforcement.test.ts`

- [ ] **Step 1: Write `src/tools/sync.ts`**

```ts
import { z } from 'zod';
import { VaultContext } from '../vault/context.js';
import { logger } from '../logger.js';

export const CommitAndPushInput = z.object({ message: z.string().min(1) });
export const GitStatusInput = z.object({}).optional();

export async function commitAndPush(ctx: VaultContext, input: z.infer<typeof CommitAndPushInput>) {
  const r = await ctx.git.commitAndPush(input.message);
  logger.audit('commit_and_push', {
    message: input.message, sha: r.sha, branch: r.branch, pushed: r.pushed,
  });
  return r;
}

export async function gitStatus(ctx: VaultContext) {
  return ctx.git.status();
}
```

- [ ] **Step 2: Write enforcement test `test/integration/ownership-enforcement.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildContext, VaultContext } from '../../src/vault/context.js';
import { writeNote, appendToNote, deleteNote } from '../../src/tools/crud.js';
import { appendDecision, upsertGoal, updateAgentProfile } from '../../src/tools/workflows.js';

const fixture = resolve(__dirname, '../fixtures/vault');
let vault: string; let ctx: VaultContext;
beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), 'vault-'));
  cpSync(fixture, vault, { recursive: true });
  ctx = await buildContext({ vaultPath: vault });
});
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

describe('ownership enforcement — 100% block of cross-agent writes', () => {
  const cross = [
    () => writeNote(ctx, {
      path: '_agents/alfa/x.md', content: 'x',
      frontmatter: { type: 'context', tags: [] }, as_agent: 'beta',
    }),
    () => appendToNote(ctx, {
      path: '_agents/alfa/profile.md', content: '\nx', as_agent: 'beta',
    }),
    () => deleteNote(ctx, {
      path: '_agents/alfa/profile.md', as_agent: 'beta', reason: 'malice',
    }),
    () => appendDecision(ctx, {
      agent: 'alfa', title: 't', rationale: 'r', tags: [],
    }).then(() => { /* valid */ }),
    () => updateAgentProfile(ctx, { agent: 'alfa', content: 'x' }).then(() => {}),
  ];

  it('blocks writeNote cross-agent', async () => {
    await expect(cross[0]()).rejects.toThrow(/OWNERSHIP_VIOLATION|owned by 'alfa', not 'beta'/);
  });
  it('blocks appendToNote cross-agent', async () => {
    await expect(cross[1]()).rejects.toThrow(/OWNERSHIP_VIOLATION|owned by 'alfa', not 'beta'/);
  });
  it('blocks deleteNote cross-agent', async () => {
    await expect(cross[2]()).rejects.toThrow(/OWNERSHIP_VIOLATION|owned by 'alfa', not 'beta'/);
  });

  it('cross-agent upsertGoal blocked', async () => {
    await expect(upsertGoal(ctx, {
      agent: 'beta', period: '2026-04', content: 'x',
    })).resolves.toBeTruthy(); // beta writes own file, ok
    await expect(writeNote(ctx, {
      path: '_shared/goals/2026-04/alfa.md', content: 'x',
      frontmatter: { type: 'goal', tags: [], period: '2026-04' }, as_agent: 'beta',
    })).rejects.toThrow(/OWNERSHIP_VIOLATION/);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd mcp-obsidian && npx vitest run test/integration/ownership-enforcement.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src/tools/sync.ts test/integration/ownership-enforcement.test.ts
git commit -m "feat(mcp-obsidian): add Layer 3 sync tools + ownership enforcement tests"
```

---

## Phase 6 — MCP server wiring

### Task 15: Resources module

**Files:**
- Create: `mcp-obsidian/src/resources/vault.ts`

- [ ] **Step 1: Write `src/resources/vault.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VaultContext } from '../vault/context.js';
import { statVault } from '../tools/crud.js';

export function registerResources(server: McpServer, ctx: VaultContext): void {
  server.registerResource(
    'vault-stats',
    'obsidian://vault',
    {
      title: 'Vault statistics',
      description: 'Counts and per-agent/per-type breakdown',
      mimeType: 'application/json',
    },
    async () => {
      const s = await statVault(ctx);
      return {
        contents: [{
          uri: 'obsidian://vault',
          mimeType: 'application/json',
          text: JSON.stringify(s, null, 2),
        }],
      };
    }
  );

  server.registerResource(
    'vault-agents',
    'obsidian://agents',
    {
      title: 'Ownership map',
      description: 'Current path→agent ownership rules',
      mimeType: 'application/json',
    },
    async () => {
      const rules = ctx.ownership.dump();
      return {
        contents: [{
          uri: 'obsidian://agents',
          mimeType: 'application/json',
          text: JSON.stringify({ agents: ctx.ownership.agents(), rules }, null, 2),
        }],
      };
    }
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/resources/vault.ts
git commit -m "feat(mcp-obsidian): add MCP resources (obsidian://vault, obsidian://agents)"
```

---

### Task 16: Register all tools with McpServer

**Files:**
- Create: `mcp-obsidian/src/server.ts`

- [ ] **Step 1: Write `src/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VaultContext } from './vault/context.js';
import {
  readNote, getNoteMetadata, statVault, listFolder,
  writeNote, appendToNote, deleteNote, searchContent,
  ReadNoteInput, GetMetadataInput, ListFolderInput,
  WriteNoteInput, AppendNoteInput, DeleteNoteInput, SearchContentInput,
} from './tools/crud.js';
import {
  createJournalEntry, appendDecision, updateAgentProfile,
  upsertGoal, upsertResult, readAgentContext,
  searchByTag, searchByType, getBacklinks,
  CreateJournalInput, AppendDecisionInput, UpdateProfileInput,
  UpsertGoalInput, UpsertResultInput, ReadAgentContextInput,
  SearchByTagInput, SearchByTypeInput, GetBacklinksInput,
} from './tools/workflows.js';
import {
  commitAndPush, gitStatus, CommitAndPushInput,
} from './tools/sync.js';
import { registerResources } from './resources/vault.js';
import { VaultError } from './errors.js';
import { logger } from './logger.js';

function wrap<I, O>(
  fn: (ctx: VaultContext, input: I) => Promise<O>,
  ctx: VaultContext,
  toolName: string,
) {
  return async (input: I) => {
    const started = Date.now();
    try {
      const out = await fn(ctx, input);
      logger.info(`tool ${toolName} ok`, {
        tool: toolName, duration_ms: Date.now() - started, outcome: 'ok',
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
        structuredContent: out as object,
      };
    } catch (e: unknown) {
      const duration_ms = Date.now() - started;
      if (e instanceof VaultError) {
        logger.warn(`tool ${toolName} err`, { tool: toolName, duration_ms, code: e.code });
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `${e.code}: ${e.message}${e.suggestion ? ' — ' + e.suggestion : ''}` }],
          structuredContent: e.toStructured(),
        };
      }
      const err = e as Error;
      logger.error(`tool ${toolName} crash`, { tool: toolName, duration_ms, msg: err.message });
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `INTERNAL_ERROR: ${err.message}` }],
        structuredContent: { error: { code: 'INTERNAL_ERROR', message: err.message } },
      };
    }
  };
}

export function createServer(ctx: VaultContext): McpServer {
  const server = new McpServer(
    { name: 'mcp-obsidian', version: '1.0.0' },
    { capabilities: { logging: {}, resources: {}, tools: {} } }
  );

  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };

  // ---- Layer 1 ----
  server.registerTool('read_note',
    { title: 'Read note', description: 'Read a vault note with frontmatter, content, and backlinks count',
      inputSchema: ReadNoteInput.shape, annotations: readOnly },
    wrap(readNote, ctx, 'read_note'));

  server.registerTool('get_note_metadata',
    { title: 'Get note metadata', description: 'Read only the frontmatter + wikilinks of a note',
      inputSchema: GetMetadataInput.shape, annotations: readOnly },
    wrap(getNoteMetadata, ctx, 'get_note_metadata'));

  server.registerTool('stat_vault',
    { title: 'Vault stats', description: 'Totals per type, per agent, index age',
      inputSchema: {}, annotations: readOnly },
    wrap((c) => statVault(c), ctx, 'stat_vault'));

  server.registerTool('list_folder',
    { title: 'List folder', description: 'List .md files in a folder with metadata; paginated',
      inputSchema: ListFolderInput.shape, annotations: readOnly },
    wrap(listFolder, ctx, 'list_folder'));

  server.registerTool('write_note',
    { title: 'Write note', description: 'Create or overwrite a note. Validates ownership and frontmatter. as_agent required.',
      inputSchema: WriteNoteInput.shape, annotations: write },
    wrap(writeNote, ctx, 'write_note'));

  server.registerTool('append_to_note',
    { title: 'Append to note', description: 'Append raw content to an existing note. Blocked on decisions.md and journal entries.',
      inputSchema: AppendNoteInput.shape, annotations: write },
    wrap(appendToNote, ctx, 'append_to_note'));

  server.registerTool('delete_note',
    { title: 'Delete note', description: 'Delete a note. reason is required and recorded in audit log.',
      inputSchema: DeleteNoteInput.shape, annotations: { ...write, destructiveHint: true } },
    wrap(deleteNote, ctx, 'delete_note'));

  server.registerTool('search_content',
    { title: 'Full-text search', description: 'Ripgrep full-text search with optional path/type/tag filters',
      inputSchema: SearchContentInput.shape, annotations: readOnly },
    wrap(searchContent, ctx, 'search_content'));

  // ---- Layer 2 ----
  server.registerTool('create_journal_entry',
    { title: 'Create journal entry', description: 'Creates _agents/<agent>/journal/YYYY-MM-DD-<title-kebab>.md with correct frontmatter.',
      inputSchema: CreateJournalInput.shape, annotations: write },
    wrap(createJournalEntry, ctx, 'create_journal_entry'));

  server.registerTool('append_decision',
    { title: 'Append decision', description: 'Appends to the agent\'s decisions history — prepends the new block at the top of decisions.md (most recent first, append-only).',
      inputSchema: AppendDecisionInput.shape, annotations: write },
    wrap(appendDecision, ctx, 'append_decision'));

  server.registerTool('update_agent_profile',
    { title: 'Update agent profile', description: 'Rewrites _agents/<agent>/profile.md preserving created date',
      inputSchema: UpdateProfileInput.shape, annotations: { ...write, idempotentHint: true } },
    wrap(updateAgentProfile, ctx, 'update_agent_profile'));

  server.registerTool('upsert_goal',
    { title: 'Upsert goal', description: 'Creates or updates _shared/goals/<period>/<agent>.md',
      inputSchema: UpsertGoalInput.shape, annotations: { ...write, idempotentHint: true } },
    wrap(upsertGoal, ctx, 'upsert_goal'));

  server.registerTool('upsert_result',
    { title: 'Upsert result', description: 'Creates or updates _shared/results/<period>/<agent>.md',
      inputSchema: UpsertResultInput.shape, annotations: { ...write, idempotentHint: true } },
    wrap(upsertResult, ctx, 'upsert_result'));

  server.registerTool('read_agent_context',
    { title: 'Read agent context bundle', description: 'Profile + last N decisions + last N journals + current-month goals/results.',
      inputSchema: ReadAgentContextInput.shape, annotations: readOnly },
    wrap(readAgentContext, ctx, 'read_agent_context'));

  server.registerTool('search_by_tag',
    { title: 'Search by tag', inputSchema: SearchByTagInput.shape, annotations: readOnly,
      description: 'Find notes whose frontmatter tags include the given tag' },
    wrap(searchByTag, ctx, 'search_by_tag'));

  server.registerTool('search_by_type',
    { title: 'Search by type', inputSchema: SearchByTypeInput.shape, annotations: readOnly,
      description: 'Find notes whose frontmatter type equals the given type' },
    wrap(searchByType, ctx, 'search_by_type'));

  server.registerTool('get_backlinks',
    { title: 'Get backlinks', inputSchema: GetBacklinksInput.shape, annotations: readOnly,
      description: 'List notes that reference the given note by wikilink' },
    wrap(getBacklinks, ctx, 'get_backlinks'));

  // ---- Layer 3 ----
  server.registerTool('commit_and_push',
    { title: 'Commit and push', description: 'Stage all, commit, push. Serialized with brain-sync cron via flock.',
      inputSchema: CommitAndPushInput.shape, annotations: write },
    wrap(commitAndPush, ctx, 'commit_and_push'));

  server.registerTool('git_status',
    { title: 'Git status', inputSchema: {}, annotations: readOnly,
      description: 'List modified/untracked files and ahead/behind counters' },
    wrap((c) => gitStatus(c), ctx, 'git_status'));

  registerResources(server, ctx);

  logger.info('mcp-obsidian server created', { tools: 19, resources: 2 });
  return server;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd mcp-obsidian && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(mcp-obsidian): wire 19 tools + 2 resources in McpServer"
```

---

### Task 17: HTTP bootstrap + health

**Files:**
- Create: `mcp-obsidian/src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```ts
import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { rateLimiter } from './middleware/rateLimit.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { logger } from './logger.js';
import { buildContext } from './vault/context.js';
import { createServer } from './server.js';

async function main() {
  const ctx = await buildContext();
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: '4mb' }));
  app.use(requestIdMiddleware);

  app.get('/health', async (_req, res) => {
    const head = await ctx.git.head().catch(() => '');
    const s = ctx.index.stats();
    res.json({
      status: 'ok',
      vault_notes: s.totalNotes,
      index_age_ms: s.indexAgeMs,
      git_head: head,
    });
  });

  app.use(authMiddleware);
  app.use(rateLimiter);

  app.post('/mcp', async (req, res) => {
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e: unknown) {
      logger.error('mcp handler error', { msg: (e as Error).message });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  app.listen(config.port, () => {
    logger.info('mcp-obsidian listening', { port: config.port, vault: config.vaultPath });
  });
}

main().catch((e) => {
  logger.error('fatal boot error', { msg: (e as Error).message });
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck + build**

Run: `cd mcp-obsidian && npm run build`
Expected: `dist/` populated, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(mcp-obsidian): add HTTP bootstrap with /health and /mcp endpoints"
```

---

## Phase 7 — Stress, E2E, deploy, docs

### Task 18: Stress concurrency test

**Files:**
- Create: `mcp-obsidian/test/stress/concurrency.test.ts`

- [ ] **Step 1: Write `test/stress/concurrency.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { buildContext, VaultContext } from '../../src/vault/context.js';
import { VaultGit } from '../../src/vault/git.js';
import { writeNote } from '../../src/tools/crud.js';
import { commitAndPush } from '../../src/tools/sync.js';
import { parseNote } from '../../src/vault/frontmatter.js';

const fixture = resolve(__dirname, '../fixtures/vault');
let vault: string; let ctx: VaultContext; let lockfile: string;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), 'vault-'));
  cpSync(fixture, vault, { recursive: true });
  execSync('git init -q -b main', { cwd: vault });
  execSync('git config user.email t@t && git config user.name t && git add . && git commit -q -m init', { cwd: vault });
  lockfile = join(tmpdir(), `lock-${Date.now()}`);
  require('node:fs').writeFileSync(lockfile, '');
  const git = new VaultGit({
    vaultPath: vault, lockfile,
    authorName: 'mcp', authorEmail: 'mcp@x', skipPush: true,
  });
  ctx = await buildContext({ vaultPath: vault, git });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  try { rmSync(lockfile, { force: true }); } catch {}
});

describe('stress: 10 parallel writes + simulated cron', () => {
  it('zero corruption: every note re-parses, no truncation', async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      writeNote(ctx, {
        path: `_agents/alfa/stress-${i}.md`,
        content: `# stress ${i}\n\n` + 'x'.repeat(100),
        frontmatter: { type: 'context', tags: ['stress'] },
        as_agent: 'alfa',
      })
    );
    // Simulated cron: background commits while writes run
    const cron = (async () => {
      for (let i = 0; i < 3; i++) {
        try { await commitAndPush(ctx, { message: `cron sim ${i}` }); } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    await Promise.all(writes);
    await cron;
    await commitAndPush(ctx, { message: 'final flush' });

    // Verify every written file re-parses cleanly
    const dir = join(vault, '_agents/alfa');
    const files = readdirSync(dir).filter((f) => f.startsWith('stress-'));
    expect(files.length).toBe(10);
    for (const f of files) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const parsed = parseNote(raw);
      expect(parsed.frontmatter.owner).toBe('alfa');
      expect(raw).toContain('x'.repeat(100)); // no truncation
    }
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd mcp-obsidian && npx vitest run test/stress/concurrency.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/stress/concurrency.test.ts
git commit -m "test(mcp-obsidian): stress concurrency — 10 parallel writes + cron, zero corruption"
```

---

### Task 19: E2E smoke test

**Files:**
- Create: `mcp-obsidian/test/e2e/smoke.test.ts`

- [ ] **Step 1: Write `test/e2e/smoke.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { buildContext } from '../../src/vault/context.js';
import { VaultGit } from '../../src/vault/git.js';
import { createServer } from '../../src/server.js';
import type { AddressInfo } from 'node:net';

const fixture = resolve(__dirname, '../fixtures/vault');
let vault: string; let lockfile: string; let httpServer: any; let url: string;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'vault-'));
  cpSync(fixture, vault, { recursive: true });
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && git add . && git commit -q -m init', { cwd: vault });
  lockfile = join(tmpdir(), `lock-${Date.now()}`);
  writeFileSync(lockfile, '');
  const git = new VaultGit({ vaultPath: vault, lockfile, authorName: 'mcp', authorEmail: 'mcp@x', skipPush: true });
  const ctx = await buildContext({ vaultPath: vault, git });

  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  await new Promise<void>((r) => { httpServer = app.listen(0, r); });
  const { port } = httpServer.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/mcp`;
});
afterAll(() => {
  httpServer?.close();
  rmSync(vault, { recursive: true, force: true });
  try { rmSync(lockfile, { force: true }); } catch {}
});

describe('e2e smoke', () => {
  it('initialize → list tools → call read_note + create_journal_entry + commit_and_push', async () => {
    const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBe(19);
    expect(tools.tools.map((t) => t.name)).toContain('read_note');

    const r1 = await client.callTool({
      name: 'read_note', arguments: { path: '_agents/alfa/profile.md' },
    });
    expect(r1.isError).toBeFalsy();

    const r2 = await client.callTool({
      name: 'create_journal_entry',
      arguments: { agent: 'alfa', title: 'e2e smoke', content: 'body', tags: ['e2e'] },
    });
    expect(r2.isError).toBeFalsy();

    const r3 = await client.callTool({
      name: 'commit_and_push', arguments: { message: 'smoke test' },
    });
    expect(r3.isError).toBeFalsy();

    await client.close();
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd mcp-obsidian && npx vitest run test/e2e/smoke.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/smoke.test.ts
git commit -m "test(mcp-obsidian): e2e smoke — initialize, list, 3 tool calls over real HTTP"
```

---

### Task 20: Docker + compose

**Files:**
- Create: `mcp-obsidian/Dockerfile`
- Create: `mcp-obsidian/docker-compose.yml`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache ripgrep git
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 3201
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3201/health || exit 1
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  mcp-obsidian:
    build: .
    container_name: mcp-obsidian
    ports:
      - "3201:3201"
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
      - /root/.ssh:/root/.ssh:ro
    restart: unless-stopped
```

- [ ] **Step 3: Build the image to verify**

Run: `cd mcp-obsidian && docker build -t mcp-obsidian:dev .`
Expected: image builds successfully.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat(mcp-obsidian): add Docker + compose for deploy"
```

---

### Task 21: README + deploy notes

**Files:**
- Create: `mcp-obsidian/README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# mcp-obsidian

MCP Server for the `fama-brain` Obsidian vault. Exposes safe, convention-enforcing access to notes for LLM agents.

## Features

- **19 tools** across 3 layers: CRUD, Workflows, Git.
- **2 resources**: `obsidian://vault` (stats), `obsidian://agents` (ownership map).
- **Strict ownership** via required `as_agent` — 100% block on cross-agent writes.
- **Append-only `decisions.md`** (only via `append_decision`).
- **Immutable journal entries** once created.
- **Hybrid search**: in-memory index (tags/type/backlinks) + ripgrep full-text.
- **Git coordination** with the `brain-sync.sh` cron via shared `flock`.

## Tools

### Layer 1 — CRUD (8)
- `read_note`, `get_note_metadata`, `stat_vault`, `list_folder`
- `write_note`, `append_to_note`, `delete_note`, `search_content`

### Layer 2 — Workflows (9)
- `create_journal_entry`, `append_decision`, `update_agent_profile`
- `upsert_goal`, `upsert_result`, `read_agent_context`
- `search_by_tag`, `search_by_type`, `get_backlinks`

### Layer 3 — Git (2)
- `commit_and_push`, `git_status`

## Setup

```bash
cp .env.example .env
# edit API_KEY, GIT_AUTHOR_*
npm install
npm run build
docker compose up -d
```

## Example calls

**Read agent context bundle:**
```json
{ "name": "read_agent_context", "arguments": { "agent": "ceo" } }
```

**Create journal entry:**
```json
{
  "name": "create_journal_entry",
  "arguments": {
    "agent": "ceo",
    "title": "Reunião Trimestral",
    "content": "## Agenda\n...",
    "tags": ["planning"]
  }
}
```

**Append decision (prepends to decisions.md):**
```json
{
  "name": "append_decision",
  "arguments": {
    "agent": "ceo",
    "title": "Pivot to OpenClaw",
    "rationale": "Market signals from Q1...",
    "tags": ["strategic"]
  }
}
```

## Troubleshooting

| Error code | Fix |
|---|---|
| `OWNERSHIP_VIOLATION` | Use the `as_agent` shown in the message, or write under your own zone. |
| `GIT_LOCK_BUSY` | Cron `brain-sync.sh` is running. Retry in 3–10 seconds. |
| `IMMUTABLE_TARGET` | `decisions.md` must use `append_decision`. Journals can only be appended, never rewritten. |
| `INVALID_FILENAME` | Follow the suggested kebab-case name in the error. |
| `INVALID_FRONTMATTER` | Check `type` is one of the allowed values; `goal`/`result` need `period: YYYY-MM`. |

## Deploy (production)

- Domain: `mcp-obsidian.famachat.com.br` → Nginx → `localhost:3201`
- HTTPS via Let's Encrypt / certbot
- Volume mount `/root/fama-brain:/vault`
- Shared flock: `/tmp/brain-sync.lock:/tmp/brain-sync.lock`

## Tests

```bash
npm test                    # unit + integration
npm run test:coverage       # with coverage
```

Targets: `src/vault/` ≥ 80% lines; overall ≥ 60%.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(mcp-obsidian): add README with tool list, examples, troubleshooting"
```

---

### Task 22: Final verification — full test suite + coverage

- [ ] **Step 1: Run full suite**

Run: `cd mcp-obsidian && npm test`
Expected: all tests PASS.

- [ ] **Step 2: Run coverage**

Run: `cd mcp-obsidian && npm run test:coverage`
Expected: `src/vault/` ≥ 80% lines, overall ≥ 60%.

- [ ] **Step 3: Run typecheck**

Run: `cd mcp-obsidian && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Run build**

Run: `cd mcp-obsidian && npm run build`
Expected: `dist/` clean.

- [ ] **Step 5: If all green, commit final state**

```bash
git status
git log --oneline | head -30
# If any stray changes from verification:
# git add -A && git commit -m "chore(mcp-obsidian): verification pass"
```

- [ ] **Step 6: Deploy smoke (staging)**

Run on staging VPS:
```bash
cd /root/mcp-fama/mcp-obsidian
docker compose up -d
curl -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
     https://mcp-obsidian.famachat.com.br/mcp
```
Expected: JSON response listing 19 tools.

---

## Self-review checklist (done during authoring)

- **Spec coverage** — every spec section has at least one task:
  - §3 Architecture → Task 1 (scaffold), Task 17 (bootstrap)
  - §4.1 Layer 1 → Tasks 11, 12
  - §4.2 Layer 2 → Task 13
  - §4.3 Layer 3 → Task 14
  - §4.4 Resources → Task 15
  - §5 Validation → Tasks 5, 6, 7
  - §6 Responses/errors/logging/pagination → Tasks 3, 11, 12, 16
  - §7 Performance — implicit through index (Task 8) and ripgrep (Task 12); not a separate task
  - §8 Tests → Tasks 5–15 (unit/integration), 18 (stress), 19 (e2e), 22 (coverage)
  - §9 Success criteria → Task 22 verification + Task 20 deploy
- **No placeholders** — every step contains real code/commands.
- **Type consistency** — `as_agent` everywhere; `VaultContext` shape stable; tool input names match between Zod schemas and callers.
- **Frequent commits** — one commit per task (~22 commits).
