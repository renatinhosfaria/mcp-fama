# mcp-obsidian Sparring Training-Target Delta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `get_training_target_delta(target_agent, since, topics?, include_content?)` — a composed read that returns (1) what the target agent itself wrote since `since`, (2) shared-contexts from other owners that mention the target via `#alvo-<target>` tag or `Agente alvo: <target>` body field, and (3) a dedicated projection of `regressoes/` entries with structured `status`/`severidade`/`categoria` parsed from the §5.8 body convention. Enables Sparring's heartbeat: "what changed about Reno since my last training round?" in one call.

**Architecture:**
- New `src/vault/regressao.ts` parses the 7-field §5.8 body convention (Agente alvo / Cenário / Comportamento esperado / Comportamento observado / Severidade / Status / Categoria + optional Histórico as timestamp list). Missing sections → `null`. Graceful — no hard errors, mirrors the lead/broker parsers.
- Small refactor in `src/tools/workflows.ts`: extract the inner loop of `getAgentDelta` into a non-handler helper `computeAgentDelta()` that both `getAgentDelta` and the new `getTrainingTargetDelta` call. Preserves behavior of the existing tool (still 29-tool-compatible, no test changes).
- `getTrainingTargetDelta` composes:
  1. `computeAgentDelta(target_agent, …)` for `target_agent_delta`
  2. Iterate `ctx.index.byType('shared-context')` filtering `owner !== target_agent && (tags includes '#alvo-<target>' OR parseRegressaoBody(body).agente_alvo === target)`, respecting optional `topics[]` filter. That list is `shared_about_target` (dedup by path).
  3. Filter `shared_about_target` where `topic === 'regressoes'`, parse body, project `{status, severidade, categoria}` onto each entry → `regressions`.
  4. `total = target_agent_delta_total + shared_about_target.length + regressions.length` (double-counted by spec design: regressions is a projection, not an exclusion).
- No new error codes (reuses `INVALID_TIME_RANGE` via `validateTimeRange`).

**Tech Stack:** No new dependencies. Pure TS additions + existing zod/vitest tooling.

**Spec reference:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md` — §4.2 row for `get_training_target_delta` (line 178), §4.5 annotations (`readOnlyHint: true`), §5.8 `regressoes/` body convention (lines 476-511), §7 performance target `< 100ms`, §8 validation of parser (line 700: "parser de `regressoes/` extrai os 7 campos …; campos ausentes viram `null` no retorno estruturado; campo `Histórico` opcional é parseado como lista de timestamps quando presente").

**Prerequisites:**
- Plans 1-4 merged and deployed (29 tools live on `https://mcp-obsidian.famachat.com.br`).
- `validateTimeRange`, `validateOwners`, `ctx.index.byType('shared-context')` already exist.
- Ownership patterns `_shared/context/*/<agent>/**` cover regressoes writes (wildcard topic segment) — **no AGENTS.md change needed**.
- `src/vault/lead.ts` exists as a template for the parser mechanics (though regressao is simpler: no timestamped blocks, only header sections + optional list).

**Out of scope (Plans 6-7):**
- Financial snapshot type + tools (Plan 6 — cfo-exec).
- Broker executive views (`get_broker_operational_summary`, `list_brokers_needing_attention`) + broker exec fields (`nivel_atencao`, `ultima_acao_recomendada`) (Plan 7 — ceo-exec).
- Enforcement of §5.8 regressoes tags (rejected in §10: flexibility wins).
- Auto-tagging heuristics on regressoes body (rejected in §10: false positives).
- `read_regression_summary`/`upsert_regression_context` wrappers (§11 upgrade path, only if volume justifies).

---

## File Structure

```
src/
├── vault/
│   └── regressao.ts                       # NEW — parser for §5.8 regressoes body (7 fields + optional Histórico)
└── tools/
    └── workflows.ts                       # MODIFY — extract computeAgentDelta helper; add getTrainingTargetDelta handler
└── server.ts                              # MODIFY — register new tool (30 total)
test/
├── unit/
│   └── regressao.test.ts                  # NEW — parser unit tests (5 cases)
├── integration/
│   └── training-target-delta.test.ts      # NEW — tool integration tests (6 cases)
└── e2e/
    └── smoke.test.ts                      # MODIFY — assert 30 tools
README.md                                  # MODIFY — tool row + plans 1-5 banner
```

---

## Phase A — Regressoes body parser

### Task A1: Write failing unit tests

**Files:** `test/unit/regressao.test.ts` (NEW)

- [ ] **Step 1: Create the test file**

```ts
// test/unit/regressao.test.ts
import { describe, it, expect } from 'vitest';
import { parseRegressaoBody } from '../../src/vault/regressao.js';

describe('parseRegressaoBody', () => {
  it('extracts all 7 canonical fields', () => {
    const body = `## Agente alvo
reno

## Cenário
Lead objetou entrada alta; Reno respondeu em tom frio.

## Comportamento esperado
Reconhecer a objeção, oferecer alternativa (entrada menor / parcela maior).

## Comportamento observado
"Entendo, mas esse é o valor." — tom seco, sem alternativa.

## Severidade
alta

## Status
aberta

## Categoria
tom

## Histórico
- 2026-04-10 14:30 regressão detectada
- 2026-04-12 09:00 retestada, mesmo comportamento
`;
    const r = parseRegressaoBody(body);
    expect(r.agente_alvo).toBe('reno');
    expect(r.cenario).toContain('tom frio');
    expect(r.comportamento_esperado).toContain('alternativa');
    expect(r.comportamento_observado).toContain('seco');
    expect(r.severidade).toBe('alta');
    expect(r.status).toBe('aberta');
    expect(r.categoria).toBe('tom');
    expect(r.historico).toEqual([
      '2026-04-10 14:30 regressão detectada',
      '2026-04-12 09:00 retestada, mesmo comportamento',
    ]);
  });

  it('returns null for missing sections (graceful degradation)', () => {
    const body = `## Agente alvo
followup

## Severidade
media
`;
    const r = parseRegressaoBody(body);
    expect(r.agente_alvo).toBe('followup');
    expect(r.severidade).toBe('media');
    expect(r.cenario).toBeNull();
    expect(r.comportamento_esperado).toBeNull();
    expect(r.status).toBeNull();
    expect(r.categoria).toBeNull();
    expect(r.historico).toBeNull();
  });

  it('returns all-null for empty body', () => {
    const r = parseRegressaoBody('');
    expect(r.agente_alvo).toBeNull();
    expect(r.cenario).toBeNull();
    expect(r.comportamento_esperado).toBeNull();
    expect(r.comportamento_observado).toBeNull();
    expect(r.severidade).toBeNull();
    expect(r.status).toBeNull();
    expect(r.categoria).toBeNull();
    expect(r.historico).toBeNull();
  });

  it('trims whitespace from single-line sections', () => {
    const body = `## Agente alvo
   reno   

## Severidade
    baixa  
`;
    const r = parseRegressaoBody(body);
    expect(r.agente_alvo).toBe('reno');
    expect(r.severidade).toBe('baixa');
  });

  it('historico without dash-list entries returns null', () => {
    const body = `## Histórico
no list items, just prose that shouldn't be a list
`;
    const r = parseRegressaoBody(body);
    expect(r.historico).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module not found)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/regressao.test.ts
```

Expected: `Cannot find module '../../src/vault/regressao.js'` or similar.

### Task A2: Implement the parser

**Files:** `src/vault/regressao.ts` (NEW)

- [ ] **Step 1: Write the parser**

```ts
// src/vault/regressao.ts

export interface RegressaoBody {
  agente_alvo: string | null;
  cenario: string | null;
  comportamento_esperado: string | null;
  comportamento_observado: string | null;
  severidade: string | null;
  status: string | null;
  categoria: string | null;
  historico: string[] | null;
}

const SECTION_RE = /^##\s+(.+?)\s*$/;

function normalizeKey(raw: string): string {
  // lowercase + strip accents so "Cenário" → "cenario", "Histórico" → "historico"
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function parseRegressaoBody(body: string): RegressaoBody {
  const lines = body.split('\n');
  const sections: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      current = normalizeKey(m[1]);
      sections[current] = [];
      continue;
    }
    if (current !== null) sections[current].push(line);
  }

  const getText = (key: string): string | null => {
    const arr = sections[key];
    if (!arr) return null;
    const joined = arr.join('\n').trim();
    return joined === '' ? null : joined;
  };

  const getList = (key: string): string[] | null => {
    const arr = sections[key];
    if (!arr) return null;
    const items = arr
      .map(l => l.match(/^-\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => m[1].trim());
    return items.length === 0 ? null : items;
  };

  return {
    agente_alvo: getText('agente alvo'),
    cenario: getText('cenario'),
    comportamento_esperado: getText('comportamento esperado'),
    comportamento_observado: getText('comportamento observado'),
    severidade: getText('severidade'),
    status: getText('status'),
    categoria: getText('categoria'),
    historico: getList('historico'),
  };
}
```

- [ ] **Step 2: Run test — expect PASS (5/5)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/regressao.test.ts
```

Expected: all 5 test cases PASS.

- [ ] **Step 3: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/regressao.ts mcp-obsidian/test/unit/regressao.test.ts
git -C /root/mcp-fama commit -m "feat(vault): add regressoes body parser (§5.8 — 7 fields + historico)"
```

---

## Phase B — Refactor getAgentDelta + add getTrainingTargetDelta

### Task B1: Extract `computeAgentDelta` helper (no behavior change)

**Files:** `src/tools/workflows.ts` (lines 193-245 contain the current `getAgentDelta`)

- [ ] **Step 1: Refactor — keep existing behavior**

Replace the current block at lines 193-245 (the entire `// ─── get_agent_delta ───` section) with this refactored version. The outer handler is unchanged; the inner logic moves into a reusable helper:

```ts
// ─── get_agent_delta ─────────────────────────────────────────────────────────

export const GetAgentDeltaSchema = z.object({
  agent: z.string().min(1),
  since: z.string().datetime(),
  types: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

export interface DeltaGroups {
  decisions: any[]; journals: any[]; goals: any[]; results: any[];
  shared_contexts: any[]; entity_profiles: any[]; other: any[];
}

function bucket(pth: string): keyof DeltaGroups {
  if (/^_agents\/[^/]+\/decisions\.md$/.test(pth)) return 'decisions';
  if (/^_agents\/[^/]+\/journal\//.test(pth)) return 'journals';
  if (/^_shared\/goals\//.test(pth)) return 'goals';
  if (/^_shared\/results\//.test(pth)) return 'results';
  if (/^_shared\/context\//.test(pth)) return 'shared_contexts';
  if (/^_agents\/[^/]+\/(?!README\.md|profile\.md|decisions\.md|journal\/)[^/]+\/[^/]+\.md$/.test(pth)) return 'entity_profiles';
  return 'other';
}

export async function computeAgentDelta(
  ctx: ToolCtx,
  agent: string,
  sinceMs: number,
  types: string[] | undefined,
  includeContent: boolean,
): Promise<DeltaGroups> {
  const groups: DeltaGroups = { decisions: [], journals: [], goals: [], results: [], shared_contexts: [], entity_profiles: [], other: [] };
  const typeFilter = types ? new Set(types) : null;

  for (const e of ctx.index.byOwner(agent)) {
    if (e.mtimeMs <= sinceMs) continue;
    if (typeFilter && (!e.type || !typeFilter.has(e.type))) continue;
    let content: string;
    try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
    catch { continue; }
    const item: any = {
      path: e.path, updated: e.updated, mtime: new Date(e.mtimeMs).toISOString(),
      frontmatter: e.frontmatter,
      preview: content.slice(0, 500),
    };
    if (includeContent) item.content = content;
    groups[bucket(e.path)].push(item);
  }
  return groups;
}

export async function getAgentDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetAgentDeltaSchema.parse(args);
    const sinceMs = Date.parse(a.since);
    if (isNaN(sinceMs)) throw new McpError('VAULT_IO_ERROR', 'since must be ISO-8601');
    return await computeAgentDelta(ctx, a.agent, sinceMs, a.types, a.include_content);
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  const total = Object.values(sc).reduce<number>((acc, v: any) => acc + (v as any[]).length, 0);
  return ok(sc, `Delta: ${total} entries`);
}
```

- [ ] **Step 2: Run existing getAgentDelta tests — expect still PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/workflows.test.ts
```

Expected: all existing `get_agent_delta` tests still pass (no behavior change; pure refactor).

- [ ] **Step 3: Typecheck**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts
git -C /root/mcp-fama commit -m "refactor(workflows): extract computeAgentDelta helper (prep for training-target delta)"
```

### Task B2: Write failing integration test for training-target delta

**Files:** `test/integration/training-target-delta.test.ts` (NEW)

- [ ] **Step 1: Create the test file**

```ts
// test/integration/training-target-delta.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { getTrainingTargetDelta } from '../../src/tools/workflows.js';

describe('get_training_target_delta', () => {
  let tmp: string;
  let ctx: any;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ttd-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      [
        '```',
        '_agents/reno/**                       => reno',
        '_agents/sparring/**                   => sparring',
        '_agents/follow-up/**                  => follow-up',
        '_shared/context/*/reno/**             => reno',
        '_shared/context/*/sparring/**         => sparring',
        '_shared/context/*/follow-up/**        => follow-up',
        '```',
      ].join('\n'),
    );

    const mkNote = (rel: string, fm: Record<string, any>, body: string, mtime: Date) => {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const fmYaml = Object.entries(fm)
        .map(([k, v]) => {
          if (Array.isArray(v)) return `${k}: [${v.map(x => `"${x}"`).join(', ')}]`;
          return `${k}: ${v}`;
        })
        .join('\n');
      fs.writeFileSync(abs, `---\n${fmYaml}\n---\n${body}`);
      fs.utimesSync(abs, mtime, mtime);
    };

    // reno writes own journal (recent)
    fs.mkdirSync(path.join(tmp, '_agents/reno/journal'), { recursive: true });
    mkNote(
      '_agents/reno/journal/2026-04-14-reflection.md',
      { type: 'journal', owner: 'reno', created: '2026-04-14', updated: '2026-04-14', tags: [] },
      'Reno self-reflection.',
      new Date('2026-04-14T00:00:00Z'),
    );

    // sparring writes a regression about reno (recent, regressoes/ topic, with body + tag)
    mkNote(
      '_shared/context/regressoes/sparring/reno-tom-frio.md',
      {
        type: 'shared-context',
        owner: 'sparring',
        created: '2026-04-12',
        updated: '2026-04-12',
        tags: ['#alvo-reno', '#regressao-aberta', '#severidade-alta', '#categoria-tom'],
        topic: 'regressoes',
        title: 'Reno tom frio em objeção',
      },
      [
        '## Agente alvo',
        'reno',
        '',
        '## Cenário',
        'Lead objetou entrada alta.',
        '',
        '## Severidade',
        'alta',
        '',
        '## Status',
        'aberta',
        '',
        '## Categoria',
        'tom',
        '',
      ].join('\n'),
      new Date('2026-04-12T00:00:00Z'),
    );

    // follow-up writes a shared-context in aprendizados/ mentioning reno via tag (recent)
    mkNote(
      '_shared/context/aprendizados/follow-up/reno-melhorou.md',
      {
        type: 'shared-context',
        owner: 'follow-up',
        created: '2026-04-13',
        updated: '2026-04-13',
        tags: ['#alvo-reno'],
        topic: 'aprendizados',
        title: 'Reno melhorou em objeções',
      },
      'Observação: reno está respondendo melhor.',
      new Date('2026-04-13T00:00:00Z'),
    );

    // follow-up writes a shared-context NOT mentioning reno (should be excluded)
    mkNote(
      '_shared/context/abordagens/follow-up/abertura-curta.md',
      {
        type: 'shared-context',
        owner: 'follow-up',
        created: '2026-04-13',
        updated: '2026-04-13',
        tags: ['#canal-whatsapp'],
        topic: 'abordagens',
        title: 'Abertura curta funciona',
      },
      'Abertura curta aumenta resposta.',
      new Date('2026-04-13T00:00:00Z'),
    );

    // reno writes own shared-context in regressoes/ (SELF — must be excluded from shared_about_target per spec "de outros owners")
    mkNote(
      '_shared/context/regressoes/reno/self-reflection.md',
      {
        type: 'shared-context',
        owner: 'reno',
        created: '2026-04-14',
        updated: '2026-04-14',
        tags: ['#alvo-reno'],
        topic: 'regressoes',
        title: 'Auto-reflexão',
      },
      '## Agente alvo\nreno\n',
      new Date('2026-04-14T00:00:00Z'),
    );

    // old regression (pre-since) should be excluded
    mkNote(
      '_shared/context/regressoes/sparring/old-issue.md',
      {
        type: 'shared-context',
        owner: 'sparring',
        created: '2026-01-01',
        updated: '2026-01-01',
        tags: ['#alvo-reno'],
        topic: 'regressoes',
        title: 'Old issue',
      },
      '## Agente alvo\nreno\n',
      new Date('2026-01-01T00:00:00Z'),
    );

    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('returns target_agent_delta + shared_about_target + regressions, dedupe and self-exclusion correct', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;

    // target_agent_delta: reno's own journal
    expect(sc.target_agent_delta.journals).toHaveLength(1);
    expect(sc.target_agent_delta.journals[0].path).toBe('_agents/reno/journal/2026-04-14-reflection.md');

    // shared_about_target: sparring's regression + follow-up's aprendizado (NOT reno's self + NOT the old one + NOT abordagens without tag)
    expect(sc.shared_about_target).toHaveLength(2);
    const pathsAbout = sc.shared_about_target.map((e: any) => e.path).sort();
    expect(pathsAbout).toEqual([
      '_shared/context/aprendizados/follow-up/reno-melhorou.md',
      '_shared/context/regressoes/sparring/reno-tom-frio.md',
    ]);
    // Each has topic field populated from path
    expect(sc.shared_about_target.find((e: any) => e.topic === 'regressoes')).toBeDefined();
    expect(sc.shared_about_target.find((e: any) => e.topic === 'aprendizados')).toBeDefined();

    // regressions: just the sparring one, with projected fields
    expect(sc.regressions).toHaveLength(1);
    expect(sc.regressions[0].path).toBe('_shared/context/regressoes/sparring/reno-tom-frio.md');
    expect(sc.regressions[0].status).toBe('aberta');
    expect(sc.regressions[0].severidade).toBe('alta');
    expect(sc.regressions[0].categoria).toBe('tom');

    // total = 1 (journal) + 2 (shared_about) + 1 (regressions) = 4 (double-count by spec)
    expect(sc.total).toBe(4);
  });

  it('body-only mention (no #alvo-reno tag) still matches for regressoes topic', async () => {
    // Write a regression from sparring that mentions reno ONLY in body, not tag
    const rel = '_shared/context/regressoes/sparring/body-only.md';
    const abs = path.join(tmp, rel);
    fs.writeFileSync(abs, `---
type: shared-context
owner: sparring
created: 2026-04-15
updated: 2026-04-15
tags: []
topic: regressoes
title: Body-only mention
---
## Agente alvo
reno

## Status
aberta
`);
    const mtime = new Date('2026-04-15T00:00:00Z');
    fs.utimesSync(abs, mtime, mtime);
    await ctx.index.updateAfterWrite(rel);

    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    const pathsAbout = sc.shared_about_target.map((e: any) => e.path);
    expect(pathsAbout).toContain(rel);
    const reg = sc.regressions.find((e: any) => e.path === rel);
    expect(reg).toBeDefined();
    expect(reg.status).toBe('aberta');
  });

  it('topics[] filter scopes shared_about_target and regressions but not target_agent_delta', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z', topics: ['regressoes'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    // target_agent_delta is unfiltered by topics — journal still present
    expect(sc.target_agent_delta.journals).toHaveLength(1);
    // shared_about_target should only have regressoes entries
    expect(sc.shared_about_target.every((e: any) => e.topic === 'regressoes')).toBe(true);
    // follow-up aprendizado excluded
    const hasAprendizado = sc.shared_about_target.some((e: any) => e.topic === 'aprendizados');
    expect(hasAprendizado).toBe(false);
  });

  it('include_content=true returns full body on target + shared', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z', include_content: true },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.target_agent_delta.journals[0].content).toBeDefined();
    expect(sc.shared_about_target[0].content).toBeDefined();
  });

  it('INVALID_TIME_RANGE for malformed since', async () => {
    const r = await getTrainingTargetDelta({ target_agent: 'reno', since: 'garbage' }, ctx);
    expect((r as any).structuredContent.error.code).toBe('INVALID_TIME_RANGE');
  });

  it('empty result when since is in the future', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2099-01-01T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.target_agent_delta.journals).toHaveLength(0);
    expect(sc.shared_about_target).toHaveLength(0);
    expect(sc.regressions).toHaveLength(0);
    expect(sc.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (handler not exported yet)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/training-target-delta.test.ts
```

Expected: `TypeError: getTrainingTargetDelta is not a function` or similar import error.

### Task B3: Implement the handler

**Files:** `src/tools/workflows.ts`

- [ ] **Step 1: Add import for the regressao parser at the top of the file**

Locate the existing import block (lines 1-10). Add this line after the `broker.js` import (around line 10):

```ts
import { parseRegressaoBody } from '../vault/regressao.js';
```

- [ ] **Step 2: Add schema + handler immediately after `getSharedContextDelta` (end of current `// ─── get_shared_context_delta ───` block, before `// ─── upsert_shared_context ───`)**

Append this block at the appropriate location (locate the comment `// ─── upsert_shared_context ───` and insert BEFORE it):

```ts
// ─── get_training_target_delta ───────────────────────────────────────────────

export const GetTrainingTargetDeltaSchema = z.object({
  target_agent: z.string().min(1),
  since: z.string(),
  topics: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

export async function getTrainingTargetDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetTrainingTargetDeltaSchema.parse(args);
    const window = validateTimeRange(a.since, undefined);
    const sinceMs = window.sinceMs!;
    const topicFilter = a.topics ? new Set(a.topics) : null;
    const targetTag = `#alvo-${a.target_agent}`;

    // 1) target_agent_delta (unfiltered by topics)
    const target_agent_delta = await computeAgentDelta(ctx, a.target_agent, sinceMs, undefined, a.include_content);

    // 2) shared_about_target: shared-context from OTHER owners mentioning target via #alvo-<target> tag OR body Agente alvo
    const sharedAboutMap = new Map<string, any>();
    for (const e of ctx.index.byType('shared-context')) {
      if (e.mtimeMs <= sinceMs) continue;
      if (e.owner === a.target_agent) continue; // self-exclusion per spec
      const topic = topicFromSharedContextPath(e.path);
      if (!topic) continue;
      if (topicFilter && !topicFilter.has(topic)) continue;

      const tagMatch = Array.isArray(e.tags) && e.tags.includes(targetTag);
      let bodyMatch = false;
      let content: string | null = null;
      if (!tagMatch && topic === 'regressoes') {
        // Parse body for `## Agente alvo` section
        try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
        catch { continue; }
        const parsed = parseFrontmatter(content);
        const reg = parseRegressaoBody(parsed.body);
        if (reg.agente_alvo === a.target_agent) bodyMatch = true;
      }
      if (!tagMatch && !bodyMatch) continue;

      if (content === null) {
        try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
        catch { continue; }
      }

      const item: any = {
        path: e.path,
        owner: e.owner,
        topic,
        mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter,
        preview: content.slice(0, 500),
      };
      if (a.include_content) item.content = content;
      sharedAboutMap.set(e.path, item);
    }
    const shared_about_target = [...sharedAboutMap.values()];

    // 3) regressions: subset of shared_about_target where topic === 'regressoes', with body fields projected
    const regressions: any[] = [];
    for (const item of shared_about_target) {
      if (item.topic !== 'regressoes') continue;
      let fullContent = item.content;
      if (!fullContent) {
        try { ({ content: fullContent } = await readFileAtomic(safeJoin(ctx.vaultRoot, item.path))); }
        catch { continue; }
      }
      const parsed = parseFrontmatter(fullContent);
      const reg = parseRegressaoBody(parsed.body);
      regressions.push({
        ...item,
        status: reg.status,
        severidade: reg.severidade,
        categoria: reg.categoria,
      });
    }

    const target_agent_delta_total = Object.values(target_agent_delta).reduce<number>((acc, v: any) => acc + v.length, 0);
    const total = target_agent_delta_total + shared_about_target.length + regressions.length;

    return { target_agent_delta, shared_about_target, regressions, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Training-target delta for '${(args as any).target_agent}': ${v.total} entries (agent+shared+regressions)`);
}
```

Note on imports already present in `src/tools/workflows.ts`:
- `parseFrontmatter` from `../vault/frontmatter.js` (line 5).
- `readFileAtomic`, `safeJoin` from `../vault/fs.js` (line 4).
- `validateTimeRange`, `tryToolBody`, `ok` from `./_shared.js` (line 3).
- `topicFromSharedContextPath` — this helper was defined locally in the `getSharedContextDelta` section in Plan 4. It's at module scope within the same file, so the new handler can reference it directly. **Verify** it's `function` not `const` (it is — plan 4 declared `function topicFromSharedContextPath(rel: string): string | null`).

- [ ] **Step 3: Run test — expect PASS (6/6)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/training-target-delta.test.ts
```

Expected: all 6 cases PASS.

- [ ] **Step 4: Typecheck**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/training-target-delta.test.ts
git -C /root/mcp-fama commit -m "feat(workflows): add get_training_target_delta (Sparring heartbeat)"
```

---

## Phase C — Server registry + e2e smoke

### Task C1: Register new tool and bump e2e tool count

**Files:** `src/server.ts`, `test/e2e/smoke.test.ts`

- [ ] **Step 1: Add registry entry in `src/server.ts`**

Locate the `get_shared_context_delta:` line (added in Plan 4, around line 56-57). Insert the new line **immediately after** it. Match the alignment style of neighboring rows.

Insert:

```ts
  get_training_target_delta: { schema: wf.GetTrainingTargetDeltaSchema, handler: wf.getTrainingTargetDelta, desc: 'Training-target delta: agent + shared-about + regressions', annotations: { readOnlyHint: true, openWorldHint: false } },
```

- [ ] **Step 2: Update e2e smoke test**

In `test/e2e/smoke.test.ts`, line 79-82 currently says `29`. Bump both occurrences to `30`:

```ts
  it('initialize + tools/list returns 30 tools', async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 's', version: '0' } });
    const r = await rpc('tools/list', {});
    expect(r.result.tools.length).toBe(30);
  });
```

- [ ] **Step 3: Run typecheck + non-e2e tests**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
npx vitest run --exclude 'test/e2e/**'
```

Expected: typecheck clean; all tests pass (including new 5 unit + 6 integration cases from Phases A-B).

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/server.ts mcp-obsidian/test/e2e/smoke.test.ts
git -C /root/mcp-fama commit -m "feat(server): register get_training_target_delta (30 tools)"
```

---

## Phase D — Docs

### Task D1: Update README

**Files:** `README.md`

- [ ] **Step 1: Bump plans banner**

Current README line 5-9 (written in Plan 4) lists Plans 1-4. Replace with:

```
This repo implements **Plans 1-5** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`:
- **Plan 1** (Foundation + Core): HTTP transport, auth, vault layer (fs, frontmatter, ownership, index, git), 22 tools + 2 resources.
- **Plan 2** (Lead pattern for Reno): `entity_type=lead` first-class with 3 tools and §5.5 body convention.
- **Plan 3** (Broker pattern for FamaAgent + temporal filters): `entity_type=broker` first-class with 3 tools and §5.6 body convention. `since`/`until` temporal filters on `list_folder`/`search_content`/`search_by_tag`/`search_by_type`. §5.7 broker isolation convention.
- **Plan 4** (Follow-up heartbeat): `get_shared_context_delta(since, topics?, owners?)` cross-agent read grouped by topic. §5.8 canonical 6-topic taxonomy documented as convention (opt-out, objecoes, retomadas, aprendizados, abordagens, regressoes).
- **Plan 5** (Sparring training-target): `get_training_target_delta(target_agent, since, topics?)` composed read — target's own delta + shared-contexts (from other owners) mentioning target via `#alvo-<target>` or body field + `regressoes/` projection with parsed status/severidade/categoria.

Plans 6-7 add financial snapshots (cfo-exec) and executive broker views (ceo-exec).
```

- [ ] **Step 2: Bump Quickstart expected output**

Line around `Expected output: \`29\`.` → change `29` to `30`.

- [ ] **Step 3: Bump section heading to "Tools (30)" and generic count to "Workflows — generic (14)"**

- `## Tools (29)` → `## Tools (30)`
- `### Workflows — generic (13)` → `### Workflows — generic (14)`

- [ ] **Step 4: Add tool row under "Workflows — generic"**

Insert **immediately after** the `get_shared_context_delta` row added in Plan 4:

```
| `get_training_target_delta` | `(target_agent, since, topics?, include_content?)` | (read) target's agent_delta + shared-about-target (from other owners, by `#alvo-<target>` tag or body) + regressoes projection with status/severidade/categoria parsed |
```

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/README.md
git -C /root/mcp-fama commit -m "docs(readme): document get_training_target_delta (30 tools)"
```

---

## Phase E — Deploy + dogfood

### Task E1: Build + deploy

- [ ] **Step 1: Build the TS bundle**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run build
```

Expected: `dist/` emitted; `grep -c 'getTrainingTargetDelta' dist/tools/workflows.js` returns ≥ 1 and `grep -c 'get_training_target_delta' dist/server.js` returns ≥ 1.

- [ ] **Step 2: Build Docker image + force-update Swarm service**

```bash
cd /root/mcp-fama/mcp-obsidian
docker build -t mcp-obsidian:latest .
docker service update --force --image mcp-obsidian:latest mcp-obsidian_mcp-obsidian
```

Expected: `Service mcp-obsidian_mcp-obsidian converged` after ~20s.

- [ ] **Step 3: Verify live endpoint**

```bash
API_KEY=$(docker exec $(docker ps -q --filter 'name=mcp-obsidian') sh -c 'cat $API_KEY_FILE')
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); t=r["result"]["tools"]; print("Total:", len(t)); print("Has get_training_target_delta:", "get_training_target_delta" in [x["name"] for x in t])'
```

Expected: `Total: 30` + `Has get_training_target_delta: True`.

### Task E2: Dogfood

- [ ] **Step 1: Write a regressao under sparring targeting reno**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"upsert_shared_context","arguments":{"as_agent":"sparring","topic":"regressoes","slug":"plano-5-dogfood","title":"Plan 5 dogfood","content":"## Agente alvo\nreno\n\n## Cenário\nDogfood do Plan 5.\n\n## Severidade\nbaixa\n\n## Status\naberta\n\n## Categoria\noutro\n","tags":["#alvo-reno","#regressao-aberta","#severidade-baixa","#categoria-outro","dogfood"]}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"], indent=2))'
```

Expected: `created _shared/context/regressoes/sparring/plano-5-dogfood.md`.

- [ ] **Step 2: Call get_training_target_delta for reno**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_training_target_delta","arguments":{"target_agent":"reno","since":"2026-04-16T00:00:00Z","topics":["regressoes"]}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c '
import json, sys
r = json.load(sys.stdin)
sc = r["result"]["structuredContent"]
print("total:", sc["total"])
print("shared_about_target count:", len(sc["shared_about_target"]))
print("regressions count:", len(sc["regressions"]))
for reg in sc["regressions"]:
    print(" - reg:", reg["path"], "status:", reg["status"], "severidade:", reg["severidade"], "categoria:", reg["categoria"])
'
```

Expected: at least 1 entry in `regressions` with `status: aberta`, `severidade: baixa`, `categoria: outro`, matching the dogfood slug.

- [ ] **Step 3: Cleanup**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_note","arguments":{"path":"_shared/context/regressoes/sparring/plano-5-dogfood.md","as_agent":"sparring","reason":"dogfood cleanup Plan 5"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"], indent=2))'
```

Expected: `{deleted: true, path: '_shared/context/regressoes/sparring/plano-5-dogfood.md'}`.

- [ ] **Step 4: INVALID_TIME_RANGE path**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_training_target_delta","arguments":{"target_agent":"reno","since":"not-a-date"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"].get("error", r["result"]["structuredContent"]), indent=2))'
```

Expected: `{code: 'INVALID_TIME_RANGE', ...}`.

---

## Self-Review Checklist

- [ ] **Spec coverage:**
  - §4.2 row for `get_training_target_delta` (line 178) → Phase B Task B3 handler.
  - §4.5 annotation `readOnlyHint: true` → Phase C Task C1 server registration.
  - §5.8 regressoes body convention (7 fields + optional Histórico) → Phase A Tasks A1/A2 parser + tests.
  - §7 performance target `< 100ms` → honored by indexed `byType('shared-context')` lookup + selective body-read only for `regressoes/` without tag match.
  - §8 validation of parser graceful degradation ("campos ausentes viram `null`") → Phase A Task A1 test cases 2 and 3.
  - Self-exclusion ("shared-contexts de outros owners") → Phase B Task B3 handler `if (e.owner === a.target_agent) continue;` + test case 1 assertion.
  - No-dedup total ("regressions é projeção, não exclusão") → Phase B Task B3 handler `total = ... + shared_about_target.length + regressions.length` + test case 1 assertion `expect(sc.total).toBe(4)`.
- [ ] **Placeholder scan:** All tests are concrete; all schema/handler/parser code is concrete; no TBD/TODO.
- [ ] **Type consistency:** `parseRegressaoBody` return type `RegressaoBody` (Phase A) used implicitly in Phase B handler (spreads `{status, severidade, categoria}`). `getTrainingTargetDelta` name consistent in test, handler, server registry. `computeAgentDelta` signature `(ctx, agent, sinceMs, types, includeContent)` used by both `getAgentDelta` (refactored) and `getTrainingTargetDelta`. `topicFromSharedContextPath` (defined in Plan 4) reused as module-scope helper.
- [ ] **Error paths:** `INVALID_TIME_RANGE` via `validateTimeRange(a.since, undefined)` (Phase B Task B3 line 5 of handler).
- [ ] **Count invariant:** 29 → 30 tools (asserted in e2e test + README + server registry).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-mcp-obsidian-sparring-training-target.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch fresh subagent per phase, I review between phases.

**2. Inline Execution** — execute tasks in this session with checkpoints.

**Which approach?**
