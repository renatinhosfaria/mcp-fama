# mcp-obsidian ceo-exec Broker Executive Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the final 2 executive broker tools — `get_broker_operational_summary(as_agent, broker_name, …)` (single-broker composed read with computed facts + descriptive `sinais_de_risco`) and `list_brokers_needing_attention(as_agent, since?, …)` (portfolio scan with priority ordering). Extend broker frontmatter with `nivel_atencao?` + `ultima_acao_recomendada?` and add new error `INVALID_RELATIVE_TIME`. This completes the spec (Plans 1-7 = 34 tools).

**Architecture:**
- Both tools are pure compositions over the existing `VaultIndex` + `parseBrokerBody` parser — no new parser, no new path convention, no new ownership pattern.
- `get_broker_operational_summary` reads one broker doc, parses frontmatter + body once, then computes 6 structured facts from the interactions list. `sinais_de_risco` is a list of **descriptive strings** (no score, no heuristic tagging — per §10 YAGNI).
- `list_brokers_needing_attention` scans all `_agents/<as_agent>/broker/*.md` entries from the index (O(N) linear — acceptable for < 200 brokers per §7), parses each to compute the per-broker facts, applies filters (all AND-composed), and orders by `priority_score` (fixed formula, not customisable per §10).
- `since?` accepts BOTH relative (`^\d+[dwmy]$`) and ISO-8601. A new helper `parseRelativeOrIsoSince(since, now)` returns a `sinceMs` value or throws `INVALID_RELATIVE_TIME`.
- Broker schema extension (`nivel_atencao?`, `ultima_acao_recomendada?`) plugs into the existing merge logic in `upsertBrokerProfile` — same treatment as `equipe`/`nivel_engajamento`. `ultima_acao_recomendada` rejects `\n` (one-line invariant mirrors the `*_resumo` rule in Plan 6).
- Priority formula (spec §4.2 line 188, hard-coded per §10):  
  `priority_score = dias_desde_ultima_interacao + (pendencias_count × 3) + (dificuldades_repetidas_count × 2) + nivel_atencao_weight`  
  with `nivel_atencao_weight = {normal: 0, atencao: 5, risco: 15, critico: 30}`.  
  Null dias (no interactions yet) → treated as 0 for scoring (avoids NaN); this broker still passes any `since` filter since "infinite inactivity" > any threshold.

**Tech Stack:** No new dependencies. Reuses `parseBrokerBody`, `parseFrontmatter`, `readFileAtomic`, `safeJoin`, `VaultIndex.byType`/`byOwner`.

**Spec reference:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md` —
- §4.2 rows for `get_broker_operational_summary` (line 187), `list_brokers_needing_attention` (line 188).
- §4.5 annotations (`readOnlyHint: true`).
- §5.1 `nivel_atencao` / `ultima_acao_recomendada` frontmatter extension (line 245, broker sub-branch extended by ceo-exec addendum).
- §5.6 executive fields section (lines 381-391), including vocabulary for `nivel_atencao` (`normal`/`atencao`/`risco`/`critico`) and one-line convention for `ultima_acao_recomendada`.
- §6.2 new error `INVALID_RELATIVE_TIME` (line 631).
- §7 performance targets: `get_broker_operational_summary < 150ms`, `list_brokers_needing_attention < 500ms` (line 668-669).
- §10 explicit YAGNI decisions: no single health score (line 780), no auto-detect of `nivel_atencao` (line 781), no trend computation (line 782), no customizable score (line 783).

**Prerequisites:**
- Plans 1-6 merged and deployed (32 tools live on `https://mcp-obsidian.famachat.com.br`).
- `parseBrokerBody` / `BrokerBody` / `BrokerInteraction` already in `src/vault/broker.ts`.
- `UpsertBrokerProfileSchema` + `upsertBrokerProfile` already in `src/tools/workflows.ts` with merge logic covering frontmatter scalar fields via the `for (const field of [...])` loop — we just add `nivel_atencao` and `ultima_acao_recomendada` to that loop.
- `BROKER_NOT_FOUND` and `MALFORMED_BROKER_BODY` error codes already exist from Plan 3.
- No new AGENTS.md patterns needed — all reads/writes go under existing `_agents/<as_agent>/broker/**` ownership.

**Out of scope (post-Plan 7 upgrade paths per §11):**
- Secondary index by `nivel_atencao` (§11 — only when vault crosses 200 brokers).
- `set_broker_attention_level` wrapper with history-log side-effect (§11).
- `get_brokers_aggregate_stats` cross-portfolio metrics (§11).
- `compare_financial_snapshots` (§11 — unrelated to this plan).

---

## File Structure

```
src/
├── errors.ts                                    # MODIFY — add INVALID_RELATIVE_TIME
├── vault/
│   └── frontmatter.ts                           # MODIFY — add nivel_atencao + ultima_acao_recomendada to EntityProfileSchema broker sub-branch
└── tools/
    ├── _shared.ts                               # MODIFY — add parseRelativeOrIsoSince helper
    └── workflows.ts                             # MODIFY — extend UpsertBrokerProfileSchema; add GetBrokerOperationalSummarySchema + handler; add ListBrokersNeedingAttentionSchema + handler
└── server.ts                                    # MODIFY — register 2 new tools (34 total)
test/
├── unit/
│   ├── errors.test.ts                           # MODIFY — bump to 20 codes
│   ├── frontmatter.test.ts                      # MODIFY — add nivel_atencao / ultima_acao_recomendada cases
│   └── relative-time.test.ts                    # NEW — parseRelativeOrIsoSince unit tests (6 cases)
├── integration/
│   ├── broker-workflow.test.ts                  # MODIFY — add 1 case: upsert with nivel_atencao + ultima_acao_recomendada preserved via read_broker_history frontmatter
│   ├── broker-operational-summary.test.ts       # NEW — (6 cases)
│   └── brokers-needing-attention.test.ts        # NEW — (7 cases)
└── e2e/
    └── smoke.test.ts                            # MODIFY — assert 34 tools
README.md                                        # MODIFY — Plans 1-7 banner, tool count 34, 2 new rows, §5.6 exec section
```

---

## Phase A — Error + schema

### Task A1: Add `INVALID_RELATIVE_TIME` error code

**Files:** `src/errors.ts`, `test/unit/errors.test.ts`

- [ ] **Step 1: Add code to union in `src/errors.ts`**

Locate the `ErrorCode` union. After `'SNAPSHOT_NOT_FOUND'` (last line), append `'INVALID_RELATIVE_TIME'`. Move the trailing `;` to the new last line:

```ts
  | 'SNAPSHOT_NOT_FOUND'
  | 'INVALID_RELATIVE_TIME';
```

- [ ] **Step 2: Update the test**

Read `test/unit/errors.test.ts` first (`cat /root/mcp-fama/mcp-obsidian/test/unit/errors.test.ts`). Extend the codes array and bump the count from 19 → 20:

```ts
const codes: ErrorCode[] = [
  'OWNERSHIP_VIOLATION', 'UNMAPPED_PATH', 'INVALID_FRONTMATTER',
  'INVALID_FILENAME', 'INVALID_OWNER', 'IMMUTABLE_TARGET',
  'JOURNAL_IMMUTABLE', 'NOTE_NOT_FOUND', 'WIKILINK_TARGET_MISSING',
  'GIT_LOCK_BUSY', 'GIT_PUSH_FAILED', 'VAULT_IO_ERROR',
  'LEAD_NOT_FOUND', 'MALFORMED_LEAD_BODY',
  'BROKER_NOT_FOUND', 'MALFORMED_BROKER_BODY', 'INVALID_TIME_RANGE',
  'INVALID_PERIOD', 'SNAPSHOT_NOT_FOUND',
  'INVALID_RELATIVE_TIME',
];
expect(codes.length).toBe(20);
```

- [ ] **Step 3: Run test — expect PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/errors.test.ts
```

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/errors.ts mcp-obsidian/test/unit/errors.test.ts
git -C /root/mcp-fama commit -m "feat(errors): add INVALID_RELATIVE_TIME (list_brokers_needing_attention since filter)"
```

### Task A2: Extend broker frontmatter schema with exec fields

**Files:** `src/vault/frontmatter.ts`, `test/unit/frontmatter.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/unit/frontmatter.test.ts` inside the existing `describe('entity_type=broker sub-branch', …)` block (or a new describe if the broker describe isn't extensible). Use verbatim:

```ts
describe('broker sub-branch executive extension (Plan 7)', () => {
  it('accepts nivel_atencao and ultima_acao_recomendada', () => {
    const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: Maria Eduarda
nivel_atencao: risco
ultima_acao_recomendada: ligar para alinhar pendência sobre lead João Silva
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).nivel_atencao).toBe('risco');
    expect((r.frontmatter as any).ultima_acao_recomendada).toContain('ligar para alinhar');
  });

  it('rejects ultima_acao_recomendada containing newline', () => {
    const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: X
ultima_acao_recomendada: "line1\\nline2"
---
body`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('accepts nivel_atencao as free string (vocabulary not enforced per §5.6)', () => {
    const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: X
nivel_atencao: experimental-level
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).nivel_atencao).toBe('experimental-level');
  });
});
```

- [ ] **Step 2: Run — expect FAIL on `ultima_acao_recomendada`-with-newline case (currently silently accepted)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/frontmatter.test.ts
```

- [ ] **Step 3: Extend `EntityProfileSchema` in `src/vault/frontmatter.ts`**

Locate the existing `EntityProfileSchema = BaseSchema.extend({…}).passthrough();` block. Add 2 new fields inside the `.extend({…})` object, inside the broker-specific section (right after `pendencias_abertas`):

```ts
  // Broker-specific (Plan 3)
  equipe: z.string().optional(),
  nivel_engajamento: z.string().optional(),
  comunicacao_estilo: z.string().optional(),
  contato_email: z.string().optional(),
  contato_whatsapp: z.string().optional(),
  dificuldades_recorrentes: z.array(z.string()).optional(),
  padroes_atendimento: z.string().optional(),
  pendencias_abertas: z.array(z.string()).optional(),
  // Broker-exec (Plan 7)
  nivel_atencao: z.string().optional(),
  ultima_acao_recomendada: z.string().refine(s => !s.includes('\n'), 'ultima_acao_recomendada must be one line').optional(),
```

- [ ] **Step 4: Run — expect 3/3 PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/frontmatter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/frontmatter.ts mcp-obsidian/test/unit/frontmatter.test.ts
git -C /root/mcp-fama commit -m "feat(frontmatter): add broker nivel_atencao + ultima_acao_recomendada (§5.6 exec)"
```

---

## Phase B — Extend `upsertBrokerProfile` schema + merge

### Task B1: Add exec fields to upsert schema + merge logic

**Files:** `src/tools/workflows.ts`, `test/integration/broker-workflow.test.ts`

- [ ] **Step 1: Add failing test for round-trip of exec fields**

Append a new case to `test/integration/broker-workflow.test.ts` (inside the existing describe):

```ts
it('Plan 7: upsert_broker_profile preserves nivel_atencao + ultima_acao_recomendada in frontmatter', async () => {
  await upsertBrokerProfile(
    {
      as_agent: 'famaagent',
      broker_name: 'Maria Eduarda',
      resumo: 'Broker ativa',
      nivel_atencao: 'risco',
      ultima_acao_recomendada: 'agendar 1:1 sobre entrada alta',
    },
    ctx,
  );
  const r = await readBrokerHistory(
    { as_agent: 'famaagent', broker_name: 'Maria Eduarda' },
    ctx,
  );
  const fm = (r as any).structuredContent.broker;
  expect(fm.nivel_atencao).toBe('risco');
  expect(fm.ultima_acao_recomendada).toBe('agendar 1:1 sobre entrada alta');

  // Update without passing exec fields → must preserve
  await upsertBrokerProfile(
    { as_agent: 'famaagent', broker_name: 'Maria Eduarda', resumo: 'v2' },
    ctx,
  );
  const r2 = await readBrokerHistory(
    { as_agent: 'famaagent', broker_name: 'Maria Eduarda' },
    ctx,
  );
  const fm2 = (r2 as any).structuredContent.broker;
  expect(fm2.nivel_atencao).toBe('risco');
  expect(fm2.ultima_acao_recomendada).toBe('agendar 1:1 sobre entrada alta');
});

it('Plan 7: upsert_broker_profile rejects ultima_acao_recomendada with newline', async () => {
  const r = await upsertBrokerProfile(
    {
      as_agent: 'famaagent',
      broker_name: 'Bad Broker',
      ultima_acao_recomendada: 'line1\nline2',
    },
    ctx,
  );
  expect((r as any).structuredContent.error.code).toBe('INVALID_FRONTMATTER');
});
```

- [ ] **Step 2: Run — expect 2 FAILs (fields not yet accepted by schema)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/broker-workflow.test.ts
```

- [ ] **Step 3: Extend `UpsertBrokerProfileSchema`**

Locate `UpsertBrokerProfileSchema` in `src/tools/workflows.ts` (around line 750). Append 2 fields to the schema, AFTER `dificuldades_recorrentes` and BEFORE `tags`:

```ts
export const UpsertBrokerProfileSchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  resumo: z.string().optional(),
  comunicacao: z.string().optional(),
  padroes_atendimento: z.string().optional(),
  pendencias_abertas: z.array(z.string()).optional(),
  equipe: z.string().optional(),
  nivel_engajamento: z.string().optional(),
  comunicacao_estilo: z.string().optional(),
  contato_email: z.string().optional(),
  contato_whatsapp: z.string().optional(),
  dificuldades_recorrentes: z.array(z.string()).optional(),
  nivel_atencao: z.string().optional(),
  ultima_acao_recomendada: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
});
```

- [ ] **Step 4: Thread new fields through merge logic in `upsertBrokerProfile`**

Inside `upsertBrokerProfile`, locate the existing for-loop that merges frontmatter scalar fields (around lines 807-811). Currently:

```ts
for (const field of ['equipe', 'nivel_engajamento', 'comunicacao_estilo', 'contato_email', 'contato_whatsapp', 'padroes_atendimento'] as const) {
  const passed = (a as any)[field];
  if (passed !== undefined) fm[field] = passed;
  else if (priorFm?.[field] !== undefined) fm[field] = priorFm[field];
}
```

Extend the array to include the 2 new fields:

```ts
for (const field of ['equipe', 'nivel_engajamento', 'comunicacao_estilo', 'contato_email', 'contato_whatsapp', 'padroes_atendimento', 'nivel_atencao', 'ultima_acao_recomendada'] as const) {
  const passed = (a as any)[field];
  if (passed !== undefined) fm[field] = passed;
  else if (priorFm?.[field] !== undefined) fm[field] = priorFm[field];
}
```

Add a tool-level defense for the `\n` rule in `ultima_acao_recomendada`. Inside `upsertBrokerProfile`, right after `const a = UpsertBrokerProfileSchema.parse(args);`, insert:

```ts
if (typeof a.ultima_acao_recomendada === 'string' && a.ultima_acao_recomendada.includes('\n')) {
  throw new McpError('INVALID_FRONTMATTER', 'ultima_acao_recomendada must be one line (no newline)');
}
```

(The frontmatter schema `.refine()` also catches this at parse-time on subsequent reads; this tool-level check rejects bad input immediately on write.)

- [ ] **Step 5: Run — expect all broker-workflow tests PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/broker-workflow.test.ts
```

- [ ] **Step 6: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/broker-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(workflows): upsert_broker_profile accepts nivel_atencao + ultima_acao_recomendada (§5.6)"
```

---

## Phase C — Relative-time parser

### Task C1: Add `parseRelativeOrIsoSince` helper

**Files:** `src/tools/_shared.ts`, `test/unit/relative-time.test.ts` (NEW)

- [ ] **Step 1: Write failing unit tests**

Create `test/unit/relative-time.test.ts`:

```ts
// test/unit/relative-time.test.ts
import { describe, it, expect } from 'vitest';
import { parseRelativeOrIsoSince } from '../../src/tools/_shared.js';

describe('parseRelativeOrIsoSince', () => {
  const now = Date.parse('2026-04-16T12:00:00Z');

  it('parses 7d → 7 days before now', () => {
    const ms = parseRelativeOrIsoSince('7d', now);
    const diff = now - ms;
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses 30d, 1w, 2m, 1y correctly', () => {
    expect(now - parseRelativeOrIsoSince('30d', now)).toBe(30 * 86400_000);
    expect(now - parseRelativeOrIsoSince('1w',  now)).toBe(7 * 86400_000);
    expect(now - parseRelativeOrIsoSince('2m',  now)).toBe(60 * 86400_000);
    expect(now - parseRelativeOrIsoSince('1y',  now)).toBe(365 * 86400_000);
  });

  it('parses ISO-8601 datetime passthrough', () => {
    const ms = parseRelativeOrIsoSince('2026-04-09T00:00:00Z', now);
    expect(ms).toBe(Date.parse('2026-04-09T00:00:00Z'));
  });

  it('throws INVALID_RELATIVE_TIME for garbage', () => {
    expect(() => parseRelativeOrIsoSince('garbage', now)).toThrow(/INVALID_RELATIVE_TIME/);
  });

  it('throws INVALID_RELATIVE_TIME for empty string', () => {
    expect(() => parseRelativeOrIsoSince('', now)).toThrow(/INVALID_RELATIVE_TIME/);
  });

  it('throws INVALID_RELATIVE_TIME for partial match (7days)', () => {
    expect(() => parseRelativeOrIsoSince('7days', now)).toThrow(/INVALID_RELATIVE_TIME/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (helper not exported)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/relative-time.test.ts
```

- [ ] **Step 3: Implement in `src/tools/_shared.ts`**

Append at the end of `src/tools/_shared.ts`:

```ts
const RELATIVE_RE = /^(\d+)([dwmy])$/;

export function parseRelativeOrIsoSince(since: string, nowMs: number): number {
  const m = since.match(RELATIVE_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const unitMs = unit === 'd' ? 86400_000
                 : unit === 'w' ? 7 * 86400_000
                 : unit === 'm' ? 30 * 86400_000
                 : unit === 'y' ? 365 * 86400_000
                 : 0;
    return nowMs - n * unitMs;
  }
  const iso = Date.parse(since);
  if (!isNaN(iso)) return iso;
  throw new McpError('INVALID_RELATIVE_TIME', `since must match '^\\d+[dwmy]$' (e.g. '7d', '1w', '2m', '1y') or be ISO-8601; got '${since}'`);
}
```

- [ ] **Step 4: Run — expect 6/6 PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/relative-time.test.ts
```

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/_shared.ts mcp-obsidian/test/unit/relative-time.test.ts
git -C /root/mcp-fama commit -m "feat(shared): add parseRelativeOrIsoSince (relative + ISO-8601 dual format)"
```

---

## Phase D — `get_broker_operational_summary`

### Task D1: Write failing integration tests

**Files:** `test/integration/broker-operational-summary.test.ts` (NEW)

- [ ] **Step 1: Create test file**

```ts
// test/integration/broker-operational-summary.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import {
  upsertBrokerProfile,
  appendBrokerInteraction,
  getBrokerOperationalSummary,
} from '../../src/tools/workflows.js';

describe('get_broker_operational_summary', () => {
  let tmp: string;
  let ctx: any;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bos-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      '```\n_agents/famaagent/** => famaagent\n```',
    );
    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('BROKER_NOT_FOUND when broker doc missing', async () => {
    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Ghost Broker' },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('BROKER_NOT_FOUND');
  });

  it('returns broker frontmatter + descriptive sinais_de_risco when no interactions', async () => {
    await upsertBrokerProfile(
      {
        as_agent: 'famaagent',
        broker_name: 'Alpha Broker',
        nivel_atencao: 'atencao',
        ultima_acao_recomendada: 'agendar 1:1',
        pendencias_abertas: ['retornar sobre X', 'confirmar agenda Y', 'validar lead Z'],
      },
      ctx,
    );
    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Alpha Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.broker.entity_name).toBe('Alpha Broker');
    expect(sc.broker.nivel_atencao).toBe('atencao');
    expect(sc.broker.ultima_acao_recomendada).toBe('agendar 1:1');
    expect(sc.pendencias_abertas).toHaveLength(3);
    expect(sc.dias_desde_ultima_interacao).toBeNull();
    expect(sc.total_interacoes_periodo_atual).toBe(0);
    expect(sc.total_interacoes_periodo_anterior).toBe(0);
    expect(sc.dificuldades_repetidas).toEqual([]);
    // sinais_de_risco should mention pendencias count (3)
    expect(sc.sinais_de_risco.some((s: string) => s.toLowerCase().includes('3') && s.includes('pendência'))).toBe(true);
  });

  it('counts interactions in current vs previous period windows', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Beta Broker', resumo: 'x' },
      ctx,
    );

    // Build interactions: 3 in last 28 days, 2 in the prior 28-day window (days 28-56 ago)
    const now = new Date();
    const mkTs = (daysAgo: number) => {
      const d = new Date(now.getTime() - daysAgo * 86400_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };

    for (const daysAgo of [2, 10, 20, 35, 45]) {
      await appendBrokerInteraction(
        {
          as_agent: 'famaagent',
          broker_name: 'Beta Broker',
          channel: 'whatsapp',
          summary: `interaction ${daysAgo}d ago`,
          timestamp: mkTs(daysAgo),
        },
        ctx,
      );
    }

    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Beta Broker', periodo_tendencia_dias: 28 },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.total_interacoes_periodo_atual).toBe(3);
    expect(sc.total_interacoes_periodo_anterior).toBe(2);
    expect(sc.dias_desde_ultima_interacao).toBe(2);
  });

  it('dificuldades_repetidas only surfaces counts >= 2 in current window', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Gamma Broker', resumo: 'x' },
      ctx,
    );
    const now = new Date();
    const mkTs = (daysAgo: number) => {
      const d = new Date(now.getTime() - daysAgo * 86400_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Gamma Broker', channel: 'whatsapp', summary: 's', dificuldade: 'objeção entrada', timestamp: mkTs(5) }, ctx);
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Gamma Broker', channel: 'whatsapp', summary: 's', dificuldade: 'objeção entrada', timestamp: mkTs(10) }, ctx);
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Gamma Broker', channel: 'whatsapp', summary: 's', dificuldade: 'timing', timestamp: mkTs(15) }, ctx);

    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Gamma Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.dificuldades_repetidas).toEqual([{ dificuldade: 'objeção entrada', count: 2 }]);
  });

  it('sinais_de_risco mentions inactivity when dias_desde_ultima_interacao > 7', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Delta Broker', resumo: 'x' },
      ctx,
    );
    const d = new Date(Date.now() - 14 * 86400_000);
    const ts = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Delta Broker', channel: 'whatsapp', summary: 's', timestamp: ts }, ctx);

    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Delta Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.dias_desde_ultima_interacao).toBeGreaterThanOrEqual(13);
    expect(sc.dias_desde_ultima_interacao).toBeLessThanOrEqual(15);
    expect(sc.sinais_de_risco.some((s: string) => s.toLowerCase().includes('sem interação'))).toBe(true);
  });

  it('recent_interactions respects n_recent_interactions=5 default', async () => {
    await upsertBrokerProfile(
      { as_agent: 'famaagent', broker_name: 'Epsilon Broker', resumo: 'x' },
      ctx,
    );
    const now = new Date();
    const mkTs = (daysAgo: number) => {
      const d = new Date(now.getTime() - daysAgo * 86400_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };
    for (const daysAgo of [1, 3, 5, 7, 9, 11, 13]) {
      await appendBrokerInteraction({ as_agent: 'famaagent', broker_name: 'Epsilon Broker', channel: 'whatsapp', summary: `s${daysAgo}`, timestamp: mkTs(daysAgo) }, ctx);
    }
    const r = await getBrokerOperationalSummary(
      { as_agent: 'famaagent', broker_name: 'Epsilon Broker' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.recent_interactions).toHaveLength(5);
    // Most recent first
    expect(sc.recent_interactions[0].summary).toBe('s1');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/broker-operational-summary.test.ts
```

### Task D2: Implement the handler

**Files:** `src/tools/workflows.ts`

- [ ] **Step 1: Add schema + handler at end of `src/tools/workflows.ts` (after the broker section, before the financial section — or at the very bottom of the file)**

```ts
// ─── get_broker_operational_summary ──────────────────────────────────────────

export const GetBrokerOperationalSummarySchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  n_recent_interactions: z.number().int().positive().optional().default(5),
  periodo_tendencia_dias: z.number().int().positive().optional().default(28),
});

interface DificuldadeCount { dificuldade: string; count: number; }

export async function getBrokerOperationalSummary(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetBrokerOperationalSummarySchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) {
      throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}. Run upsert_broker_profile first.`);
    }

    const { content } = await readFileAtomic(safe);
    const parsed = parseFrontmatter(content);
    const body = parseBrokerBody(parsed.body);
    const interactions = body.interactions.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const nowMs = Date.now();
    const periodMs = a.periodo_tendencia_dias * 86400_000;
    const atualStartMs = nowMs - periodMs;
    const anteriorStartMs = nowMs - 2 * periodMs;

    const parseTs = (ts: string): number => {
      // YYYY-MM-DD HH:MM (assume UTC for stability)
      const iso = ts.replace(' ', 'T') + ':00Z';
      return Date.parse(iso);
    };

    let diasDesdeUltima: number | null = null;
    if (interactions.length > 0) {
      const lastMs = parseTs(interactions[0].timestamp);
      diasDesdeUltima = Math.floor((nowMs - lastMs) / 86400_000);
    }

    let atual = 0;
    let anterior = 0;
    const difCounts = new Map<string, number>();
    for (const i of interactions) {
      const ms = parseTs(i.timestamp);
      if (ms >= atualStartMs) {
        atual++;
        const d = (i as any).dificuldade;
        if (typeof d === 'string' && d.trim() !== '') {
          difCounts.set(d, (difCounts.get(d) ?? 0) + 1);
        }
      } else if (ms >= anteriorStartMs) {
        anterior++;
      }
    }
    const dificuldadesRepetidas: DificuldadeCount[] = [];
    for (const [d, c] of difCounts) if (c >= 2) dificuldadesRepetidas.push({ dificuldade: d, count: c });

    const sinais: string[] = [];
    if (diasDesdeUltima !== null && diasDesdeUltima > 7) {
      sinais.push(`sem interação há ${diasDesdeUltima} dias`);
    }
    const fm = parsed.frontmatter ?? {};
    const pendenciasList: string[] = Array.isArray(fm.pendencias_abertas) ? fm.pendencias_abertas : [];
    if (pendenciasList.length >= 3) {
      sinais.push(`${pendenciasList.length} pendências abertas`);
    } else if (pendenciasList.length >= 1) {
      sinais.push(`${pendenciasList.length} pendência${pendenciasList.length > 1 ? 's' : ''} aberta${pendenciasList.length > 1 ? 's' : ''}`);
    }
    for (const { dificuldade, count } of dificuldadesRepetidas) {
      sinais.push(`dificuldade '${dificuldade}' apareceu ${count}x em ${a.periodo_tendencia_dias} dias`);
    }
    if (atual > 0 && anterior > 0) {
      const queda = Math.round((1 - atual / anterior) * 100);
      if (queda >= 30) sinais.push(`queda de ${queda}% em interações vs período anterior`);
    }

    const recent = interactions.slice(0, a.n_recent_interactions).map(i => ({
      timestamp: i.timestamp,
      channel: i.channel,
      summary: (i as any).summary,
      dificuldade: (i as any).dificuldade ?? null,
      encaminhamento: (i as any).encaminhamento ?? null,
      contexto_lead: (i as any).contexto_lead ?? null,
    }));

    return {
      broker: { ...fm, entity_name: fm.entity_name ?? a.broker_name },
      pendencias_abertas: pendenciasList,
      dificuldades_recorrentes: Array.isArray(fm.dificuldades_recorrentes) ? fm.dificuldades_recorrentes : [],
      recent_interactions: recent,
      dias_desde_ultima_interacao: diasDesdeUltima,
      total_interacoes_periodo_atual: atual,
      total_interacoes_periodo_anterior: anterior,
      dificuldades_repetidas: dificuldadesRepetidas,
      sinais_de_risco: sinais,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Broker '${(args as any).broker_name}': ${v.sinais_de_risco.length} sinais de risco, ${v.total_interacoes_periodo_atual} interações nos últimos ${(args as any).periodo_tendencia_dias ?? 28}d`);
}
```

- [ ] **Step 2: Run — expect 6/6 PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/broker-operational-summary.test.ts
```

- [ ] **Step 3: Typecheck**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/broker-operational-summary.test.ts
git -C /root/mcp-fama commit -m "feat(workflows): add get_broker_operational_summary (§5.6 exec view)"
```

---

## Phase E — `list_brokers_needing_attention`

### Task E1: Write failing integration tests

**Files:** `test/integration/brokers-needing-attention.test.ts` (NEW)

- [ ] **Step 1: Create test file**

```ts
// test/integration/brokers-needing-attention.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import {
  upsertBrokerProfile,
  appendBrokerInteraction,
  listBrokersNeedingAttention,
} from '../../src/tools/workflows.js';

describe('list_brokers_needing_attention', () => {
  let tmp: string;
  let ctx: any;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lbn-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      '```\n_agents/famaagent/** => famaagent\n```',
    );
    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };

    // Brokers setup: alpha=critico 3 pendencias, beta=atencao 0 pendencias, gamma=normal, delta=risco 1 pendencia
    await upsertBrokerProfile({ as_agent: 'famaagent', broker_name: 'Alpha', equipe: 'centro', nivel_atencao: 'critico', ultima_acao_recomendada: 'ligar hoje', pendencias_abertas: ['p1', 'p2', 'p3'] }, ctx);
    await upsertBrokerProfile({ as_agent: 'famaagent', broker_name: 'Beta', equipe: 'zona-sul', nivel_atencao: 'atencao', ultima_acao_recomendada: 'agendar 1:1' }, ctx);
    await upsertBrokerProfile({ as_agent: 'famaagent', broker_name: 'Gamma', equipe: 'centro', nivel_atencao: 'normal' }, ctx);
    await upsertBrokerProfile({ as_agent: 'famaagent', broker_name: 'Delta', equipe: 'zona-sul', nivel_atencao: 'risco', pendencias_abertas: ['p1'] }, ctx);
  });

  it('default filters exclude normal + default priority order', async () => {
    const r = await listBrokersNeedingAttention({ as_agent: 'famaagent' }, ctx);
    const sc = (r as any).structuredContent;
    const names = sc.brokers.map((b: any) => b.broker_name);
    expect(names).not.toContain('Gamma'); // normal excluded
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
    expect(names).toContain('Delta');
    // Priority order: Alpha (critico+3pend = 30+9 = 39) > Delta (risco+1pend = 15+3 = 18) > Beta (atencao+0 = 5)
    expect(names[0]).toBe('Alpha');
    expect(names[names.length - 1]).toBe('Beta');
  });

  it('risk_levels filter narrows to specific levels', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', risk_levels: ['critico'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.brokers).toHaveLength(1);
    expect(sc.brokers[0].broker_name).toBe('Alpha');
  });

  it('equipes filter narrows to specific team', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', equipes: ['centro'], risk_levels: ['normal', 'atencao', 'risco', 'critico'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    const names = sc.brokers.map((b: any) => b.broker_name);
    expect(names).toEqual(expect.arrayContaining(['Alpha', 'Gamma']));
    expect(names).not.toContain('Beta');
    expect(names).not.toContain('Delta');
  });

  it('min_pendencias filter excludes brokers below threshold', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', min_pendencias: 2 },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.brokers).toHaveLength(1);
    expect(sc.brokers[0].broker_name).toBe('Alpha');
  });

  it('order=alphabetical sorts by broker_name asc', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', order: 'alphabetical' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    const names = sc.brokers.map((b: any) => b.broker_name);
    expect(names).toEqual(['Alpha', 'Beta', 'Delta']);
  });

  it('INVALID_RELATIVE_TIME for bad since', async () => {
    const r = await listBrokersNeedingAttention(
      { as_agent: 'famaagent', since: 'garbage' },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_RELATIVE_TIME');
  });

  it('returns ultima_acao_recomendada inline on each broker', async () => {
    const r = await listBrokersNeedingAttention({ as_agent: 'famaagent' }, ctx);
    const sc = (r as any).structuredContent;
    const alpha = sc.brokers.find((b: any) => b.broker_name === 'Alpha');
    expect(alpha.ultima_acao_recomendada).toBe('ligar hoje');
    expect(alpha.priority_score).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/brokers-needing-attention.test.ts
```

### Task E2: Implement the handler

**Files:** `src/tools/workflows.ts`

- [ ] **Step 1: Add import for `parseRelativeOrIsoSince`**

Locate the import from `./_shared.js` in `src/tools/workflows.ts` (line 3) and add `parseRelativeOrIsoSince`:

```ts
import { ToolCtx, tryToolBody, ok, ownerCheck, validateOwners, validateTimeRange, mtimeInWindow, parseRelativeOrIsoSince } from './_shared.js';
```

- [ ] **Step 2: Append the schema + handler after `getBrokerOperationalSummary`**

```ts
// ─── list_brokers_needing_attention ──────────────────────────────────────────

export const ListBrokersNeedingAttentionSchema = z.object({
  as_agent: z.string().min(1),
  since: z.string().optional().default('7d'),
  risk_levels: z.array(z.string()).optional().default(['atencao', 'risco', 'critico']),
  equipes: z.array(z.string()).optional(),
  min_pendencias: z.number().int().nonnegative().optional(),
  min_dificuldades_repetidas: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional().default(20),
  order: z.enum(['priority', 'alphabetical', 'last_interaction']).optional().default('priority'),
});

const NIVEL_ATENCAO_WEIGHT: Record<string, number> = { normal: 0, atencao: 5, risco: 15, critico: 30 };

export async function listBrokersNeedingAttention(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ListBrokersNeedingAttentionSchema.parse(args);
    const nowMs = Date.now();
    // Validate since format (throws INVALID_RELATIVE_TIME on bad input)
    const sinceMs = parseRelativeOrIsoSince(a.since, nowMs);
    const inactivityThresholdDays = Math.floor((nowMs - sinceMs) / 86400_000);

    const riskFilter = new Set(a.risk_levels);
    const equipesFilter = a.equipes ? new Set(a.equipes) : null;
    const brokerPrefix = `_agents/${a.as_agent}/broker/`;

    const candidates: any[] = [];
    for (const e of ctx.index.byOwner(a.as_agent)) {
      if (!e.path.startsWith(brokerPrefix)) continue;
      if (!e.path.endsWith('.md')) continue;
      const fm = e.frontmatter ?? {};
      if (fm.entity_type !== 'broker') continue;

      const nivel = typeof fm.nivel_atencao === 'string' ? fm.nivel_atencao : 'normal';
      if (!riskFilter.has(nivel)) continue;
      const equipe = typeof fm.equipe === 'string' ? fm.equipe : null;
      if (equipesFilter && (!equipe || !equipesFilter.has(equipe))) continue;

      const pendencias: string[] = Array.isArray(fm.pendencias_abertas) ? fm.pendencias_abertas : [];
      if (a.min_pendencias !== undefined && pendencias.length < a.min_pendencias) continue;

      // Parse body to compute dias_desde_ultima_interacao + dificuldades_repetidas_count (current window)
      let diasDesdeUltima: number | null = null;
      let dificuldadesRepetidasCount = 0;
      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
      catch { continue; }
      try {
        const parsed = parseFrontmatter(content);
        const body = parseBrokerBody(parsed.body);
        const ints = body.interactions.slice().sort((x, y) => y.timestamp.localeCompare(x.timestamp));
        if (ints.length > 0) {
          const lastMs = Date.parse(ints[0].timestamp.replace(' ', 'T') + ':00Z');
          if (!isNaN(lastMs)) diasDesdeUltima = Math.floor((nowMs - lastMs) / 86400_000);
        }
        // dificuldades repetidas in the inactivity window (last inactivityThresholdDays days)
        const windowStartMs = nowMs - inactivityThresholdDays * 86400_000;
        const difCounts = new Map<string, number>();
        for (const i of ints) {
          const ms = Date.parse(i.timestamp.replace(' ', 'T') + ':00Z');
          if (isNaN(ms) || ms < windowStartMs) continue;
          const d = (i as any).dificuldade;
          if (typeof d === 'string' && d.trim() !== '') difCounts.set(d, (difCounts.get(d) ?? 0) + 1);
        }
        for (const c of difCounts.values()) if (c >= 2) dificuldadesRepetidasCount++;
      } catch { /* keep null/0 on parse errors */ }

      if (a.min_dificuldades_repetidas !== undefined && dificuldadesRepetidasCount < a.min_dificuldades_repetidas) continue;

      // since filter: "inactivity AT LEAST sinceMs ago". diasDesdeUltima null → broker with no interactions passes.
      if (diasDesdeUltima !== null) {
        const lastInteractionMs = nowMs - diasDesdeUltima * 86400_000;
        if (lastInteractionMs > sinceMs) continue;
      }

      const priorityScore =
        (diasDesdeUltima ?? 0) +
        pendencias.length * 3 +
        dificuldadesRepetidasCount * 2 +
        (NIVEL_ATENCAO_WEIGHT[nivel] ?? 0);

      candidates.push({
        broker_name: fm.entity_name ?? '',
        nivel_atencao: nivel,
        equipe,
        dias_desde_ultima_interacao: diasDesdeUltima,
        pendencias_count: pendencias.length,
        dificuldades_repetidas_count: dificuldadesRepetidasCount,
        ultima_acao_recomendada: typeof fm.ultima_acao_recomendada === 'string' ? fm.ultima_acao_recomendada : null,
        priority_score: priorityScore,
      });
    }

    // Order
    if (a.order === 'alphabetical') {
      candidates.sort((x, y) => x.broker_name.localeCompare(y.broker_name));
    } else if (a.order === 'last_interaction') {
      candidates.sort((x, y) => (y.dias_desde_ultima_interacao ?? 0) - (x.dias_desde_ultima_interacao ?? 0));
    } else {
      candidates.sort((x, y) => y.priority_score - x.priority_score);
    }
    const total = candidates.length;
    const brokers = candidates.slice(0, a.limit);
    return { brokers, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Brokers needing attention: ${v.brokers.length}/${v.total} (order=${(args as any).order ?? 'priority'})`);
}
```

- [ ] **Step 2: Run — expect 7/7 PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/brokers-needing-attention.test.ts
```

- [ ] **Step 3: Typecheck + full non-e2e**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
npx vitest run --exclude 'test/e2e/**'
```

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/brokers-needing-attention.test.ts
git -C /root/mcp-fama commit -m "feat(workflows): add list_brokers_needing_attention (§5.6 exec view + priority_score)"
```

---

## Phase F — Server + e2e + docs

### Task F1: Register tools + bump e2e smoke

**Files:** `src/server.ts`, `test/e2e/smoke.test.ts`

- [ ] **Step 1: Register 2 new tools in `src/server.ts`**

Locate the `read_financial_series:` entry added in Plan 6. Insert the 2 new entries immediately after it (group broker-exec tools together after financial):

```ts
  get_broker_operational_summary:  { schema: wf.GetBrokerOperationalSummarySchema,  handler: wf.getBrokerOperationalSummary,  desc: 'Broker operational summary + descriptive sinais_de_risco (§5.6)', annotations: { readOnlyHint: true, openWorldHint: false } },
  list_brokers_needing_attention:  { schema: wf.ListBrokersNeedingAttentionSchema,  handler: wf.listBrokersNeedingAttention,  desc: 'List brokers needing attention (priority_score, §5.6)',         annotations: { readOnlyHint: true, openWorldHint: false } },
```

- [ ] **Step 2: Bump e2e smoke 32 → 34**

In `test/e2e/smoke.test.ts` replace both occurrences of `32` with `34`.

- [ ] **Step 3: Typecheck + non-e2e tests**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
npx vitest run --exclude 'test/e2e/**'
```

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/server.ts mcp-obsidian/test/e2e/smoke.test.ts
git -C /root/mcp-fama commit -m "feat(server): register broker-exec tools (34 tools total — spec complete)"
```

### Task F2: Update README

**Files:** `README.md`

- [ ] **Step 1: Bump Plans banner, quickstart, tool counts**

Replace the `Plans 1-6` block with:

```
This repo implements **Plans 1-7** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`:
- **Plan 1** (Foundation + Core): HTTP transport, auth, vault layer (fs, frontmatter, ownership, index, git), 22 tools + 2 resources.
- **Plan 2** (Lead pattern for Reno): `entity_type=lead` first-class with 3 tools and §5.5 body convention.
- **Plan 3** (Broker pattern for FamaAgent + temporal filters): `entity_type=broker` first-class with 3 tools and §5.6 body convention. §5.7 broker isolation convention.
- **Plan 4** (Follow-up heartbeat): `get_shared_context_delta(since, topics?, owners?)` cross-agent read grouped by topic. §5.8 canonical 6-topic taxonomy.
- **Plan 5** (Sparring training-target): `get_training_target_delta(target_agent, since, topics?)` with `regressoes/` body-field projection.
- **Plan 6** (cfo-exec financial snapshots): `type: financial-snapshot` + `upsert_financial_snapshot` + `read_financial_series`. §5.9 body convention.
- **Plan 7** (ceo-exec broker executive views): broker `nivel_atencao?` + `ultima_acao_recomendada?`. `get_broker_operational_summary` (composed read + descriptive `sinais_de_risco`) + `list_brokers_needing_attention` (portfolio scan with fixed `priority_score` formula).

**Spec complete: 34 tools + 2 resources.**
```

- [ ] **Step 2: Quickstart expected output 32 → 34**

- [ ] **Step 3: Bump `## Tools (32)` → `## Tools (34)` and `### Workflows — generic (16)` → `### Workflows — generic (18)`**

- [ ] **Step 4: Add 2 new tool rows under "Workflows — generic"**

Insert immediately after `read_financial_series`:

```
| `get_broker_operational_summary` | `(as_agent, broker_name, n_recent_interactions?=5, periodo_tendencia_dias?=28)` | (read) composed broker summary: pendências, tendência 2-janela, dificuldades_repetidas, `sinais_de_risco` descritivos (sem score) |
| `list_brokers_needing_attention` | `(as_agent, since?='7d', risk_levels?=['atencao','risco','critico'], equipes?, min_pendencias?, min_dificuldades_repetidas?, limit?=20, order?='priority')` | (read) portfolio scan. `priority_score = dias + pendencias×3 + dificuldades_repetidas×2 + nivel_atencao_weight`. `since` accepts relative (`^\d+[dwmy]$`) or ISO-8601 |
```

- [ ] **Step 5: Add "## Broker executive views (§5.6 extension)" section after "## Financial snapshots (§5.9)"**

```
## Broker executive views (§5.6 extension)

Plan 7 adds 2 broker frontmatter fields + 2 tools for the ceo-exec use-case "which brokers need attention right now?".

### Frontmatter fields (broker sub-branch)

- **`nivel_atencao?`** — vocabulary: `normal` / `atencao` / `risco` / `critico` (free string, vocabulary not enforced per §5.6). Default semantic when absent: `normal`.
  - Changes are always **explicit** agent decisions via `upsert_broker_profile` — no auto-detect (§10 rejects heuristic-based changes; `get_broker_operational_summary` returns `sinais_de_risco` to inform the decision without taking it).
- **`ultima_acao_recomendada?`** — one-line string (rejects `\n` with `INVALID_FRONTMATTER`). Convention: verb + complement (`"ligar para alinhar pendência sobre lead João Silva"`). Surfaced inline in `list_brokers_needing_attention` so the agent doesn't need to open each broker.

### Priority formula (fixed per §10, not customisable)

    priority_score = dias_desde_ultima_interacao + (pendencias_count × 3) + (dificuldades_repetidas_count × 2) + nivel_atencao_weight

    nivel_atencao_weight = { normal: 0, atencao: 5, risco: 15, critico: 30 }

Brokers with no interactions (`dias_desde_ultima_interacao = null`) score 0 for that component but still pass `since` filters (treated as "infinite inactivity"). For alternate orderings use `order='alphabetical'` or `order='last_interaction'`.

### `sinais_de_risco` examples

Strings generated from facts — no heuristic categorisation:

- `"sem interação há 12 dias"`
- `"3 pendências abertas"`
- `"dificuldade 'objeção entrada' apareceu 4x em 28 dias"`
- `"queda de 60% em interações vs período anterior"`

No single "health score" (rejected per §10 — would obscure context). No auto-escalation of `nivel_atencao` — the agent reads `sinais_de_risco`, decides whether to change the field, and writes it via `upsert_broker_profile`.
```

- [ ] **Step 6: Append 1 new Troubleshooting row**

```
| `INVALID_RELATIVE_TIME` | `since?` in `list_brokers_needing_attention` not `^\d+[dwmy]$` and not ISO-8601 | use `'7d'`/`'30d'`/`'1w'`/`'2m'`/`'1y'` or full ISO-8601 datetime |
```

- [ ] **Step 7: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/README.md
git -C /root/mcp-fama commit -m "docs(readme): document broker executive views (§5.6) + 34-tool total (spec complete)"
```

---

## Phase G — Deploy + dogfood

### Task G1: Build + deploy

- [ ] **Step 1: TS build + Docker build + Swarm rollout**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run build
grep -c "getBrokerOperationalSummary\|listBrokersNeedingAttention" dist/tools/workflows.js dist/server.js
docker build -t mcp-obsidian:latest .
docker service update --force --image mcp-obsidian:latest mcp-obsidian_mcp-obsidian
```

Expected: grep counts ≥ 2 in both dist files; service converges.

- [ ] **Step 2: Verify 34 tools live**

```bash
API_KEY=$(docker exec $(docker ps -q --filter 'name=mcp-obsidian') sh -c 'cat $API_KEY_FILE')
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 > /tmp/tools.json
python3 -c '
import json
r = json.load(open("/tmp/tools.json"))
t = r["result"]["tools"]
names = [x["name"] for x in t]
print("Total:", len(t))
for tool in ["get_broker_operational_summary", "list_brokers_needing_attention"]:
    print(f"Has {tool}: {tool in names}")
'
```

Expected: `Total: 34` + both new tools present.

### Task G2: Dogfood

- [ ] **Step 1: famaagent creates 2 brokers with different exec fields**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"upsert_broker_profile","arguments":{"as_agent":"famaagent","broker_name":"Dogfood Alpha","equipe":"centro","nivel_atencao":"risco","ultima_acao_recomendada":"ligar hoje sobre objeção","pendencias_abertas":["dogfood p1","dogfood p2"],"tags":["dogfood"]}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"], indent=2))'

curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"upsert_broker_profile","arguments":{"as_agent":"famaagent","broker_name":"Dogfood Beta","equipe":"zona-sul","nivel_atencao":"atencao","ultima_acao_recomendada":"agendar 1:1","tags":["dogfood"]}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"], indent=2))'
```

- [ ] **Step 2: Test `list_brokers_needing_attention`**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_brokers_needing_attention","arguments":{"as_agent":"famaagent","since":"30d"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c '
import json, sys
r = json.load(sys.stdin)
sc = r["result"]["structuredContent"]
print("total:", sc["total"])
for b in sc["brokers"]:
    print(f"  - {b[\"broker_name\"]} | nivel={b[\"nivel_atencao\"]} | score={b[\"priority_score\"]} | acao={b[\"ultima_acao_recomendada\"]}")
'
```

Expected: Dogfood Alpha (risco, score ~21) ranks above Dogfood Beta (atencao, score ~5).

- [ ] **Step 3: Test `get_broker_operational_summary` on Dogfood Alpha**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_broker_operational_summary","arguments":{"as_agent":"famaagent","broker_name":"Dogfood Alpha"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c '
import json, sys
r = json.load(sys.stdin)
sc = r["result"]["structuredContent"]
print("broker nivel_atencao:", sc["broker"]["nivel_atencao"])
print("pendencias:", sc["pendencias_abertas"])
print("dias_desde_ultima:", sc["dias_desde_ultima_interacao"])
print("sinais_de_risco:", sc["sinais_de_risco"])
'
```

Expected: `nivel_atencao=risco`, 2 pendências, `dias_desde_ultima=null`, `sinais_de_risco` list with "2 pendências abertas".

- [ ] **Step 4: INVALID_RELATIVE_TIME test**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_brokers_needing_attention","arguments":{"as_agent":"famaagent","since":"garbage"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"].get("error", r["result"]["structuredContent"]), indent=2))'
```

Expected: `{code: 'INVALID_RELATIVE_TIME', ...}`.

- [ ] **Step 5: BROKER_NOT_FOUND test**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_broker_operational_summary","arguments":{"as_agent":"famaagent","broker_name":"Ghost Broker"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"].get("error", r["result"]["structuredContent"]), indent=2))'
```

Expected: `{code: 'BROKER_NOT_FOUND', ...}`.

- [ ] **Step 6: Cleanup dogfood brokers**

```bash
for slug in dogfood-alpha dogfood-beta; do
  curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"delete_note\",\"arguments\":{\"path\":\"_agents/famaagent/broker/${slug}.md\",\"as_agent\":\"famaagent\",\"reason\":\"dogfood cleanup Plan 7\"}}}" | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"], indent=2))'
done
```

Expected: both `{deleted: true, …}`.

---

## Self-Review Checklist

- [ ] **Spec coverage:**
  - §4.2 `get_broker_operational_summary` → Phase D. All return fields present: `broker`, `pendencias_abertas`, `dificuldades_recorrentes`, `recent_interactions`, `dias_desde_ultima_interacao`, `total_interacoes_periodo_atual/anterior`, `dificuldades_repetidas`, `sinais_de_risco`.
  - §4.2 `list_brokers_needing_attention` → Phase E. All 5 filters AND-composed; 3 order modes; `priority_score` formula matches spec line 188 exactly.
  - §4.5 `readOnlyHint: true` on both → Phase F Task F1 registry.
  - §5.1 broker sub-branch `nivel_atencao?`/`ultima_acao_recomendada?` → Phase A Task A2 schema + Phase B Task B1 upsert.
  - §5.6 exec fields docs + vocabulary → documented in README (Phase F Task F2 Step 5).
  - §6.2 `INVALID_RELATIVE_TIME` → Phase A Task A1 + Phase C Task C1 helper + Phase E Task E2 handler use.
  - §7 perf targets (<150ms / <500ms) → indexed lookup via `byOwner` + single body read per broker; no O(N²).
  - §10 YAGNI — single-health-score rejected (no composite returned), auto-detect rejected (`nivel_atencao` changes only via explicit write), score customisation rejected (formula hard-coded).
- [ ] **Placeholder scan:** All test/handler/schema code concrete. README additions concrete. No TBD/TODO.
- [ ] **Type consistency:** `GetBrokerOperationalSummarySchema` + `getBrokerOperationalSummary` used consistently in test/handler/server. `ListBrokersNeedingAttentionSchema` + `listBrokersNeedingAttention` same. `parseRelativeOrIsoSince(since, nowMs)` signature matches test + handler call sites. `NIVEL_ATENCAO_WEIGHT` map covers all 4 canonical values plus fallback (0) for unknown strings.
- [ ] **Error paths:** `BROKER_NOT_FOUND` (summary), `INVALID_RELATIVE_TIME` (list), `INVALID_FRONTMATTER` (upsert with bad `ultima_acao_recomendada`).
- [ ] **Count invariant:** 32 → 34 tools (asserted in e2e + README + server registry).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-mcp-obsidian-ceo-exec-broker-views.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch subagent for Phases A-F (code + docs), I handle Phase G (deploy + dogfood).

**2. Inline Execution** — execute tasks in this session with checkpoints.

**Which approach?**
