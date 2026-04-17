# mcp-obsidian Follow-up Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `get_shared_context_delta(since, topics?, owners?, include_content?)` — a cross-agent read of `shared-context` notes grouped by topic — and document the §5.8 canonical topics taxonomy in the README. Enables Follow-up's heartbeat workflow: "what did the team learn collectively since my last round?" without replaying the full bundle.

**Architecture:**
- One new read-only workflow tool. No new file parsing, no new entity type, no schema changes.
- Iterates `ctx.index.byType('shared-context')` (indexed set — O(N_shared-context), not O(N_all)) and filters by `mtime > since`, optional `topics[]` path-segment match, optional `owners[]` via existing `validateOwners`. Extracts `topic` from path `_shared/context/<topic>/<agent>/<slug>.md` (parts[2]). Groups results by topic into `{by_topic: {<topic>: [...]}, total}`.
- Preview capped at 500 bytes; full content only when `include_content=true` (mirrors `get_agent_delta`).
- §5.8 taxonomy is **convention, not enforcement** — explicitly listed in §10 as out-of-scope (flexibility wins for now). README documents the 6 canonical topics + recommended tags + body conventions for `opt-out/` and `regressoes/`.

**Tech Stack:** No new dependencies. Reuses `validateTimeRange`, `validateOwners`, `tryToolBody`, `ok` from `src/tools/_shared.ts` and the existing `VaultIndex.byType()` lookup.

**Spec reference:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md` — §4.2 row for `get_shared_context_delta` (line 177), §4.5 annotations (`readOnlyHint: true`), §5.8 Taxonomia canônica (lines 422-539), §7 performance target (< 50ms), §10 out-of-scope for taxonomy enforcement (lines 772-775).

**Prerequisites:**
- Plans 1-3 merged and deployed (28 tools live on `https://mcp-obsidian.famachat.com.br`).
- `INVALID_TIME_RANGE` already in `src/errors.ts` (added in Plan 3).
- `validateTimeRange`, `validateOwners`, `mtimeInWindow` already in `src/tools/_shared.ts`.
- `VaultIndex.byType('shared-context')` already returns all notes with `type: shared-context`.
- Ownership patterns `_shared/context/*/<agent>/**` already cover all 6 canonical topics via the wildcard segment — **no AGENTS.md change needed**.

**Out of scope (Plans 5-7):**
- `get_training_target_delta` (Plan 5 — Sparring).
- `regressoes/` body convention parser (Plan 5 — Sparring will parse §5.8 regressoes body fields for its delta).
- Enforcement of the 6 canonical topic list in `upsert_shared_context` (rejected in §10: "flexibility wins").
- Push/notify for shared-context delta (rejected in §10: out of scope for stateless MCP).
- `register_opt_out_signal` wrapper (rejected in §10: `upsert_shared_context` + §5.8 opt-out body schema covers the case).

---

## File Structure

```
src/
├── tools/
│   └── workflows.ts                    # MODIFY — add GetSharedContextDeltaSchema + getSharedContextDelta handler
└── server.ts                           # MODIFY — register new tool (29 total)
test/
├── integration/
│   └── shared-context-delta.test.ts    # NEW — full coverage of grouping, filters, include_content, INVALID_TIME_RANGE
└── e2e/
    └── smoke.test.ts                   # MODIFY — assert 29 tools
README.md                               # MODIFY — add tool row + §5.8 canonical topics section
```

---

## Phase A — Tool schema + handler (TDD)

### Task A1: Write failing integration test

**Files:** `test/integration/shared-context-delta.test.ts` (NEW)

- [ ] **Step 1: Create the test file**

```ts
// test/integration/shared-context-delta.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { getSharedContextDelta } from '../../src/tools/workflows.js';

describe('get_shared_context_delta', () => {
  let tmp: string;
  let ctx: any;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-scd-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      '```\n_shared/context/*/alfa/** => alfa\n_shared/context/*/beta/** => beta\n```',
    );

    // alfa writes 3 shared-contexts: 2 recent, 1 old
    const mkNote = (rel: string, topic: string, owner: string, mtime: Date, title = 't', body = 'body') => {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `---
type: shared-context
owner: ${owner}
created: 2026-01-01
updated: ${mtime.toISOString().slice(0, 10)}
tags: []
topic: ${topic}
title: ${title}
---
${body}`);
      fs.utimesSync(abs, mtime, mtime);
    };

    mkNote('_shared/context/opt-out/alfa/whatsapp-bloco.md', 'opt-out', 'alfa',
           new Date('2026-04-10T00:00:00Z'), 'WA block', 'Cliente pediu parar WA.');
    mkNote('_shared/context/objecoes/alfa/entrada-alta.md', 'objecoes', 'alfa',
           new Date('2026-04-12T00:00:00Z'), 'Entrada alta', 'Objecao: entrada > 20%.');
    mkNote('_shared/context/aprendizados/alfa/union-vista.md', 'aprendizados', 'alfa',
           new Date('2026-01-01T00:00:00Z'), 'Union Vista', 'Aprendizado old.');

    // beta writes 1 recent shared-context in opt-out
    mkNote('_shared/context/opt-out/beta/silencio.md', 'opt-out', 'beta',
           new Date('2026-04-14T00:00:00Z'), 'Silencio', 'Lead silenciou 3 msgs.');

    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('returns by_topic groups for shared-context entries after since', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(3); // old one excluded
    expect(Object.keys(sc.by_topic).sort()).toEqual(['objecoes', 'opt-out']);
    expect(sc.by_topic['opt-out']).toHaveLength(2);
    expect(sc.by_topic['objecoes']).toHaveLength(1);
    // Each item has required fields
    const item = sc.by_topic['opt-out'][0];
    expect(item).toHaveProperty('path');
    expect(item).toHaveProperty('owner');
    expect(item).toHaveProperty('mtime');
    expect(item).toHaveProperty('frontmatter');
    expect(item).toHaveProperty('preview');
    expect(item.preview.length).toBeLessThanOrEqual(500);
    expect(item).not.toHaveProperty('content');
  });

  it('filters by topics[]', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', topics: ['opt-out'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(2);
    expect(Object.keys(sc.by_topic)).toEqual(['opt-out']);
  });

  it('filters by owners[]', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', owners: ['beta'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(1);
    expect(sc.by_topic['opt-out'][0].owner).toBe('beta');
  });

  it('returns INVALID_OWNER for unknown owner filter', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', owners: ['ghost'] },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_OWNER');
  });

  it('include_content=true returns full content', async () => {
    const r = await getSharedContextDelta(
      { since: '2026-04-01T00:00:00Z', topics: ['opt-out'], owners: ['beta'], include_content: true },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.by_topic['opt-out'][0].content).toContain('Lead silenciou 3 msgs.');
  });

  it('returns INVALID_TIME_RANGE for malformed since', async () => {
    const r = await getSharedContextDelta({ since: 'not-a-date' }, ctx);
    expect((r as any).structuredContent.error.code).toBe('INVALID_TIME_RANGE');
  });

  it('empty result when since is in the future', async () => {
    const r = await getSharedContextDelta({ since: '2099-01-01T00:00:00Z' }, ctx);
    const sc = (r as any).structuredContent;
    expect(sc.total).toBe(0);
    expect(sc.by_topic).toEqual({});
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (handler not exported yet)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/shared-context-delta.test.ts
```

Expected: `SyntaxError` or `TypeError: getSharedContextDelta is not a function` — the test file imports `getSharedContextDelta` which doesn't exist yet.

### Task A2: Implement the handler

**Files:** `src/tools/workflows.ts`

- [ ] **Step 1: Add schema + handler at end of file (before the final export-less bottom, or after `getAgentDelta`)**

Locate the existing `getAgentDelta` block (around line 193-245) and add the new block **immediately after** it. The new code reuses imports that are already at the top of the file: `z`, `ToolCtx`, `tryToolBody`, `ok`, `validateTimeRange`, `readFileAtomic`, `safeJoin`, `McpError`, `McpToolResponse`. Add `validateOwners` to the existing import statement if it isn't there.

Check the current imports on line 3:

```ts
import { ToolCtx, tryToolBody, ok, ownerCheck, validateOwners, validateTimeRange, mtimeInWindow } from './_shared.js';
```

`validateOwners` is already imported. No import edit needed.

Add this block after the `getAgentDelta` function (right before the `// ─── upsert_shared_context ───...` separator):

```ts
// ─── get_shared_context_delta ────────────────────────────────────────────────

export const GetSharedContextDeltaSchema = z.object({
  since: z.string().datetime(),
  topics: z.array(z.string()).optional(),
  owners: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

function topicFromSharedContextPath(rel: string): string | null {
  // _shared/context/<topic>/<agent>/<slug>.md
  const parts = rel.split('/');
  if (parts.length < 5) return null;
  if (parts[0] !== '_shared' || parts[1] !== 'context') return null;
  return parts[2];
}

export async function getSharedContextDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetSharedContextDeltaSchema.parse(args);
    // validateTimeRange throws INVALID_TIME_RANGE on malformed since
    const window = validateTimeRange(a.since, undefined);
    const sinceMs = window.sinceMs!;
    const ownerList = await validateOwners(ctx, a.owners);
    const topicFilter = a.topics ? new Set(a.topics) : null;
    const ownerFilter = ownerList ? new Set(ownerList) : null;

    const byTopic: Record<string, any[]> = {};
    let total = 0;

    for (const e of ctx.index.byType('shared-context')) {
      if (e.mtimeMs <= sinceMs) continue;
      const topic = topicFromSharedContextPath(e.path);
      if (!topic) continue;
      if (topicFilter && !topicFilter.has(topic)) continue;
      if (ownerFilter && (!e.owner || !ownerFilter.has(e.owner))) continue;

      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
      catch { continue; }

      const item: any = {
        path: e.path,
        owner: e.owner,
        updated: e.updated,
        mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter,
        preview: content.slice(0, 500),
      };
      if (a.include_content) item.content = content;

      if (!byTopic[topic]) byTopic[topic] = [];
      byTopic[topic].push(item);
      total++;
    }
    return { by_topic: byTopic, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Shared context delta: ${v.total} entries across ${Object.keys(v.by_topic).length} topics`);
}
```

The check on line 3 (`validateTimeRange(a.since, undefined)`) reuses the existing helper that throws `INVALID_TIME_RANGE` — consistent with Plan 3.

`validateOwners` requires `owners` to be `string | string[] | undefined`. The schema here passes `string[] | undefined`, which the helper accepts (it normalizes internally). Verify by reading `src/tools/_shared.ts:32` — the function signature is `owner?: string | string[]`.

- [ ] **Step 2: Run test — expect PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/shared-context-delta.test.ts
```

Expected: all 7 test cases PASS.

- [ ] **Step 3: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/shared-context-delta.test.ts
git -C /root/mcp-fama commit -m "feat(workflows): add get_shared_context_delta (heartbeat cross-agent read)"
```

---

## Phase B — Server registration

### Task B1: Register new tool in server

**Files:** `src/server.ts`

- [ ] **Step 1: Add registry entry**

Locate the existing `get_agent_delta` entry in `TOOL_REGISTRY` (around line 55). Add the new entry **immediately after** it. Match the existing alignment style.

Current line 55:

```ts
  get_agent_delta:       { schema: wf.GetAgentDeltaSchema,       handler: wf.getAgentDelta,       desc: 'What agent changed since',       annotations: { readOnlyHint: true, openWorldHint: false } },
```

Insert after it:

```ts
  get_shared_context_delta: { schema: wf.GetSharedContextDeltaSchema, handler: wf.getSharedContextDelta, desc: 'What shared-context any agent wrote since', annotations: { readOnlyHint: true, openWorldHint: false } },
```

- [ ] **Step 2: Update e2e smoke test to assert 29 tools**

Open `test/e2e/smoke.test.ts` line 79-82:

```ts
  it('initialize + tools/list returns 28 tools', async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 's', version: '0' } });
    const r = await rpc('tools/list', {});
    expect(r.result.tools.length).toBe(28);
  });
```

Replace the `28` literals with `29`:

```ts
  it('initialize + tools/list returns 29 tools', async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 's', version: '0' } });
    const r = await rpc('tools/list', {});
    expect(r.result.tools.length).toBe(29);
  });
```

- [ ] **Step 3: Run typecheck + unit + integration tests — expect all PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
npx vitest run --exclude 'test/e2e/**'
```

Expected: no TS errors; all unit + integration tests pass (including the new 7 cases).

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/server.ts mcp-obsidian/test/e2e/smoke.test.ts
git -C /root/mcp-fama commit -m "feat(server): register get_shared_context_delta (29 tools)"
```

---

## Phase C — Docs

### Task C1: Update README with new tool + §5.8 taxonomy

**Files:** `README.md`

- [ ] **Step 1: Bump tool count in header + Quickstart**

Line 3 of README currently says:
```
MCP server exposing the fama-brain Obsidian vault to LLM agents with ownership enforcement, append-only decision trail, and git-coordinated sync with the `brain-sync.sh` cron.
```

Then line 5-8:
```
This repo implements **Plans 1-3** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`:
- **Plan 1** (Foundation + Core): HTTP transport, auth, vault layer (fs, frontmatter, ownership, index, git), 22 tools + 2 resources.
- **Plan 2** (Lead pattern for Reno): `entity_type=lead` first-class with 3 tools and §5.5 body convention.
- **Plan 3** (Broker pattern for FamaAgent + temporal filters): `entity_type=broker` first-class with 3 tools and §5.6 body convention. `since`/`until` temporal filters on `list_folder`/`search_content`/`search_by_tag`/`search_by_type`. §5.7 broker isolation convention.

Plans 4-7 add heartbeat/shared-context delta (Follow-up), regressões (Sparring), financial snapshots (cfo-exec), and executive views (ceo-exec).
```

Replace this block with:

```
This repo implements **Plans 1-4** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`:
- **Plan 1** (Foundation + Core): HTTP transport, auth, vault layer (fs, frontmatter, ownership, index, git), 22 tools + 2 resources.
- **Plan 2** (Lead pattern for Reno): `entity_type=lead` first-class with 3 tools and §5.5 body convention.
- **Plan 3** (Broker pattern for FamaAgent + temporal filters): `entity_type=broker` first-class with 3 tools and §5.6 body convention. `since`/`until` temporal filters on `list_folder`/`search_content`/`search_by_tag`/`search_by_type`. §5.7 broker isolation convention.
- **Plan 4** (Follow-up heartbeat): `get_shared_context_delta(since, topics?, owners?)` cross-agent read grouped by topic. §5.8 canonical 6-topic taxonomy documented as convention (opt-out, objecoes, retomadas, aprendizados, abordagens, regressoes).

Plans 5-7 add regressões-focused training delta (Sparring), financial snapshots (cfo-exec), and executive views (ceo-exec).
```

- [ ] **Step 2: Update Quickstart expected output**

Around line 20:

```
Expected output: `28`. Healthcheck: `curl localhost:3201/health` (no auth).
```

Replace with:

```
Expected output: `29`. Healthcheck: `curl localhost:3201/health` (no auth).
```

- [ ] **Step 3: Bump section heading to "Tools (29)"**

Line 47 (`## Tools (28)`) → `## Tools (29)`.

- [ ] **Step 4: Add `get_shared_context_delta` row to "Workflows — generic (12)" table**

That section heading is on line 62: `### Workflows — generic (12)`.

Replace it with `### Workflows — generic (13)`.

Find the table row in that section that currently looks like:

```
| `get_agent_delta` | `(agent, since, types?, include_content?)` | (read) grouped delta since ISO datetime |
```

Insert **immediately after** that row:

```
| `get_shared_context_delta` | `(since, topics?, owners?, include_content?)` | (read) shared-context written by any agent, grouped by topic — powers Follow-up heartbeat |
```

- [ ] **Step 5: Add new §5.8 section after the Broker isolation section**

Find the `## Broker isolation (§5.7)` heading (around line 111). Insert the following new section **immediately after** its paragraph block (before `## Troubleshooting`):

```
## Canonical shared-context topics (§5.8)

`_shared/context/<topic>/<agent>/<slug>.md` accepts any kebab single-segment `topic`, but the spec defines **6 canonical topics** with fixed semantics. Follow-up (and any agent doing a cross-agent heartbeat) consumes these via `get_shared_context_delta(topics=[...])`.

| Topic | Semântica | Escritores típicos |
|---|---|---|
| `opt-out` | Sinais de opt-out por canal, bloqueios, severidade | follow-up, reno, famaagent |
| `objecoes` | Objeções recorrentes de lead, padrões de resposta, evidência | reno, follow-up, sparring, famaagent |
| `retomadas` | Padrões de reaproximação de lead frio por estágio | follow-up |
| `aprendizados` | Aprendizados por campanha/funil/empreendimento/público | qualquer agente operacional |
| `abordagens` | Scripts/templates que funcionam ou queimam, com evidência | follow-up, reno, famaagent |
| `regressoes` | Regressões observadas em agentes (alvo: Reno), bateria de teste, padrões de erro | sparring (principal) |

**Convenção, não enforcement.** `upsert_shared_context` aceita qualquer `topic` kebab single-segment — tópicos novos são permitidos para evolução orgânica. A lista canônica é orientação; quando um tópico não-canônico firmar 3+ usos por agentes diferentes, promover via revisão da spec.

**Tags recomendadas (não enforced):**
- Canal: `#canal-whatsapp`, `#canal-telefone`, `#canal-email`, `#canal-presencial`
- Estágio funil: `#stage-frio`, `#stage-morno`, `#stage-quente`, `#stage-pos-visita`, `#stage-pos-proposta`
- Empreendimento: `#empreendimento-<slug>`

**Tags canônicas para `regressoes/`** (essenciais para queries do Sparring — Plan 5):
- Status: `#regressao-aberta`, `#regressao-em-investigacao`, `#regressao-corrigida`, `#regressao-wontfix`
- Severidade: `#severidade-alta`, `#severidade-media`, `#severidade-baixa`
- Categoria: `#categoria-tom`, `#categoria-timing`, `#categoria-objecao`, `#categoria-dados`, `#categoria-contexto`, `#categoria-outro`
- Alvo: `#alvo-reno`, `#alvo-followup`, `#alvo-famaagent`, `#alvo-sparring`, `#alvo-<agent>`

**Body convention recomendado para `opt-out/`:**

    ## Sinal
    <descrição literal do sinal — ex.: "cliente pediu pra parar mensagem por WhatsApp">

    ## Canal afetado
    <whatsapp | telefone | email | todos>

    ## Severidade
    <bloqueante | temporaria | atencao>

    ## Ação recomendada
    <o que outros agentes devem fazer — ex.: "não retomar por WhatsApp; só telefone se solicitado">

Vocabulário de severidade: `bloqueante` (não retomar nunca), `temporaria` (pausar N dias), `atencao` (sinaliza desconforto, moderar abordagem).

**Body convention recomendado para `regressoes/`** (Sparring consumirá estruturadamente em Plan 5):

    ## Agente alvo
    <reno | followup | famaagent | sparring | ceo | ...>

    ## Cenário
    <input, contexto, expectativa>

    ## Comportamento esperado
    <o que deveria ter acontecido>

    ## Comportamento observado
    <o que aconteceu — com evidência se possível>

    ## Severidade
    <alta | media | baixa>

    ## Status
    <aberta | em-investigacao | corrigida | wontfix>

    ## Categoria
    <tom | timing | objecao | dados | contexto | outro>

    ## Histórico
    <opcional — log de retests e mudanças de status, mais antigo no topo>

Em caso de divergência body ↔ tag, o **body é fonte de verdade** e a tag desatualizada vira warning para correção manual.

### Consumo típico (Follow-up heartbeat)

    get_shared_context_delta(
      since='2026-04-09T00:00:00Z',
      topics=['opt-out','retomadas','abordagens']
    )
    → { by_topic: { 'opt-out':[...], 'retomadas':[...], 'abordagens':[...] }, total: <n> }

Usado no início do heartbeat para alinhar com aprendizados/sinais coletivos da semana antes de disparar mensagens proativas.
```

- [ ] **Step 6: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/README.md
git -C /root/mcp-fama commit -m "docs(readme): document get_shared_context_delta + §5.8 canonical topics taxonomy"
```

---

## Phase D — E2E smoke + Deploy

### Task D1: Run full test suite locally

- [ ] **Step 1: Full test run**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
npm test
```

Expected: typecheck clean; all tests pass including the new 7 integration cases. E2E smoke test is excluded from `npm test` by default (requires running server) — it will be validated via dogfood in Task D3.

- [ ] **Step 2: Build production bundle**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run build
```

Expected: `dist/` emitted without errors; `dist/server.js` references `getSharedContextDelta`.

### Task D2: Deploy via Docker Swarm

- [ ] **Step 1: Build new image**

```bash
cd /root/mcp-fama/mcp-obsidian
docker build -t mcp-obsidian:latest .
```

- [ ] **Step 2: Force-update the running service**

```bash
docker service update --force --image mcp-obsidian:latest mcp-obsidian_mcp-obsidian
```

Expected: service converges in < 30s; `docker service ps mcp-obsidian_mcp-obsidian` shows the new task as `Running` and the previous task as `Shutdown`.

- [ ] **Step 3: Verify tool count via live endpoint**

```bash
API_KEY=$(cat /run/secrets/mcp_obsidian_api_key 2>/dev/null || cat /root/mcp-fama/mcp-obsidian/.env 2>/dev/null | grep '^API_KEY=' | cut -d= -f2 | tr -d '"')
curl -sH "Authorization: Bearer $API_KEY" -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

Expected output: `29`.

### Task D3: Dogfood the new tool

- [ ] **Step 1: Write a shared-context note via MCP, then read via the new delta**

```bash
# 1) upsert_shared_context (reno writes an opt-out signal)
curl -sH "Authorization: Bearer $API_KEY" -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"upsert_shared_context","arguments":{"as_agent":"reno","topic":"opt-out","slug":"plano-4-dogfood","title":"Plan 4 dogfood","content":"## Sinal\nDogfood do Plan 4.\n\n## Canal afetado\ntodos\n\n## Severidade\natencao\n\n## Ação recomendada\nRemover após validação.\n","tags":["dogfood"]}}}' | jq '.result.structuredContent'

# 2) get_shared_context_delta with a recent since
curl -sH "Authorization: Bearer $API_KEY" -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_shared_context_delta","arguments":{"since":"2026-04-16T00:00:00Z","topics":["opt-out"]}}}' | jq '.result.structuredContent'
```

Expected: the second call returns `by_topic['opt-out']` containing the dogfood entry with `owner: 'reno'` and `frontmatter.topic: 'opt-out'`.

- [ ] **Step 2: Cleanup the dogfood note**

```bash
curl -sH "Authorization: Bearer $API_KEY" -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_note","arguments":{"path":"_shared/context/opt-out/reno/plano-4-dogfood.md","as_agent":"reno","reason":"dogfood cleanup Plan 4"}}}' | jq '.result.structuredContent'
```

Expected: `{deleted: true, path: '_shared/context/opt-out/reno/plano-4-dogfood.md'}`.

- [ ] **Step 3: Test INVALID_TIME_RANGE path**

```bash
curl -sH "Authorization: Bearer $API_KEY" -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_shared_context_delta","arguments":{"since":"not-a-date"}}}' | jq '.result.structuredContent.error'
```

Expected: `{code: 'INVALID_TIME_RANGE', ...}`.

- [ ] **Step 4: Commit vault cleanup (if brain-sync hasn't already)**

```bash
cd /root/fama-brain
git status
# If the dogfood delete shows as uncommitted:
git add -A
git commit -m "[mcp-obsidian] Plan 4 dogfood cleanup"
# If brain-sync has already committed, no action needed.
```

---

## Self-Review Checklist

- [ ] Spec coverage: `get_shared_context_delta` row in §4.2 (line 177) implemented as Task A2; annotations (`readOnlyHint: true`) set in Task B1; §5.8 topics + body conventions documented in Task C1 Step 5; §7 performance target (< 50ms) honored by using indexed `byType('shared-context')` lookup (no full-index scan).
- [ ] Placeholder scan: all test code is concrete; all schema/handler code is concrete; README additions are concrete tables + code blocks, no "TBD".
- [ ] Type consistency: `GetSharedContextDeltaSchema` returns `{since, topics?, owners?, include_content?}` — matches §4.2 row and matches the test calls. Handler returns `{by_topic, total}` — matches §4.2 and test assertions. `getSharedContextDelta` name used consistently in test, handler, server registry.
- [ ] Error path: `INVALID_TIME_RANGE` (via `validateTimeRange`), `INVALID_OWNER` (via `validateOwners`) — both pre-existing; no new error codes.
- [ ] Count invariant: 28 → 29 tools (asserted in e2e + README + integration). `dist/` rebuild required before deploy (Task D1 Step 2).

---

## Execution Handoff

After saving, offer execution choice:

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-mcp-obsidian-followup-heartbeat.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch fresh subagent per task, review between tasks. Fast iteration with clean context per step.

**2. Inline Execution** — execute tasks in this session with checkpoints.

**Which approach?**
