# mcp-obsidian Financial Snapshots (cfo-exec) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class support for the `financial-snapshot` type (§5.9) with 2 dedicated tools (`upsert_financial_snapshot`, `read_financial_series`) so cfo-exec (and other financial agents: ceo-exec, cfo, ceo) can maintain per-period textual operational snapshots — Caixa / Receita / Despesa / Alertas / Contexto adicional — and read them back as a structured series for cross-period comparison.

**Architecture:**
- New top-level vault directory `_shared/financials/<period>/<agent>.md`. Period (`YYYY-MM`) is a path segment — same mechanic as `_shared/goals/` and `_shared/results/`.
- New `type: financial-snapshot` on the frontmatter enum with `period: YYYY-MM` required (injected from path) and optional one-line resumo fields + auto-computed `alertas_count`.
- New `src/vault/financial.ts` parser/serializer: 5 literal section headers (`## Caixa`, `## Receita`, `## Despesa`, `## Alertas`, `## Contexto adicional`). Missing sections → `null`. `## Alertas` parses to `string[]` (dash-list items) or `[]` when section exists but empty. Other sections return string.
- `upsert_financial_snapshot` uses **merge semantics** (like `upsert_lead_timeline`): fields not passed keep prior values; empty string / `[]` explicitly clears. Auto-extracts `caixa_resumo`/`receita_resumo`/`despesa_resumo` from first non-empty line of body section if not explicitly provided. Auto-calculates `alertas_count`.
- `read_financial_series` supports three selection modes: (a) explicit `periods[]` (missing → `SNAPSHOT_NOT_FOUND`), (b) `since`/`until` lexicographic YYYY-MM range (silent omit), (c) combined. Filter is **path-segment lexicographic**, not `mtime` — coherent with "snapshot is a period closure".
- Two new error codes: `INVALID_PERIOD` (period not `YYYY-MM`) and `SNAPSHOT_NOT_FOUND` (explicit `periods[]` missing entry).
- **Ownership patterns** added to production `_shared/context/AGENTS.md`: `_shared/financials/*/{ceo,cfo,ceo-exec,cfo-exec}.md`. Required — without these, every write fails with `UNMAPPED_PATH`.

**Tech Stack:** No new dependencies. Reuses the existing `z.preprocess(dateToIso, …)` helper for YAML date handling.

**Spec reference:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md` — §4.2 rows for `upsert_financial_snapshot` (line 173), `read_financial_series` (line 174), §4.5 annotations (`readOnlyHint` on read, `idempotentHint` on upsert), §5.1 financial-snapshot frontmatter branch (line 246), §5.4 ownership (line 275), §5.9 body convention (lines 541-604), §6.2 errors `INVALID_PERIOD`/`SNAPSHOT_NOT_FOUND` (lines 628-629), §7 performance `< 100ms` for read, `< 100ms` for write.

**Prerequisites:**
- Plans 1-5 merged and deployed (30 tools live on `https://mcp-obsidian.famachat.com.br`).
- `validateTimeRange` exists (unused here — financial uses lexicographic period comparison, not ISO-8601 datetimes).
- `parseFrontmatter`, `serializeFrontmatter`, `writeFileAtomic`, `readFileAtomic`, `safeJoin`, `statFile`, `ownerCheck`, `tryToolBody`, `ok` all already in place.
- `upsertPeriodic` pattern (used by `upsertGoal`/`upsertResult`) serves as a partial template for `upsert_financial_snapshot` merge semantics — financial is richer (merge sections, auto-resumo, alertas list) so it gets its own handler, not a parameterization.

**Out of scope (Plan 7):**
- `get_broker_operational_summary` + `list_brokers_needing_attention` + broker exec fields `nivel_atencao`/`ultima_acao_recomendada` (Plan 7 — ceo-exec).
- Cross-period delta computation (spec §10 rejects it: "agente recebe a série estruturada e calcula no próprio raciocínio").
- Numeric validation on `*_resumo` fields (spec §10 rejects it: "falsos positivos; convenção fica por disciplina humana").

---

## File Structure

```
src/
├── errors.ts                                # MODIFY — add INVALID_PERIOD, SNAPSHOT_NOT_FOUND
├── vault/
│   ├── frontmatter.ts                       # MODIFY — add 'financial-snapshot' type + FinancialSnapshotSchema
│   └── financial.ts                         # NEW — parser/serializer for §5.9 5-section body + resumo extraction
└── tools/
    └── workflows.ts                         # MODIFY — UpsertFinancialSnapshotSchema + upsertFinancialSnapshot + ReadFinancialSeriesSchema + readFinancialSeries
└── server.ts                                # MODIFY — register 2 new tools (32 total)
test/
├── unit/
│   ├── errors.test.ts                       # MODIFY — bump to 19 codes (if test asserts count)
│   ├── frontmatter.test.ts                  # MODIFY — add financial-snapshot parse/validate cases
│   └── financial.test.ts                    # NEW — parser unit tests (7 cases)
├── integration/
│   └── financial-workflow.test.ts           # NEW — upsert → read roundtrip (8 cases)
└── e2e/
    └── smoke.test.ts                        # MODIFY — assert 32 tools
README.md                                    # MODIFY — Plans 1-6 banner, quickstart 32, tool rows, §5.9 docs section

# Production vault (edited by Phase F deploy — NOT via subagent)
/root/fama-brain/_shared/context/AGENTS.md   # MODIFY — add 4 ownership patterns
```

---

## Phase A — Errors + frontmatter

### Task A1: Add 2 error codes

**Files:** `src/errors.ts`, `test/unit/errors.test.ts`

- [ ] **Step 1: Check current test assertion count**

Read `test/unit/errors.test.ts` to see whether any test asserts the total number of codes. Currently 17 codes after Plan 3. If a test asserts `codes.length === 17`, bump to `19`. If it just lists expected codes without counting, append the two new codes to the array. Preserve exactly the assertion style already in the file.

Read `test/unit/errors.test.ts` first:

```bash
cat /root/mcp-fama/mcp-obsidian/test/unit/errors.test.ts
```

- [ ] **Step 2: Add the 2 new codes in `src/errors.ts`**

Locate the `ErrorCode` union near the top of `src/errors.ts`. After the existing `'INVALID_TIME_RANGE'` line, add:

```ts
  | 'INVALID_PERIOD'
  | 'SNAPSHOT_NOT_FOUND';
```

(The final `;` moves to the last code in the union — remove it from the previous line if present.)

Final `ErrorCode` union should end like this:

```ts
  | 'MALFORMED_LEAD_BODY'
  | 'BROKER_NOT_FOUND'
  | 'MALFORMED_BROKER_BODY'
  | 'INVALID_TIME_RANGE'
  | 'INVALID_PERIOD'
  | 'SNAPSHOT_NOT_FOUND';
```

- [ ] **Step 3: Update the test — add the two new codes to whatever list assertion exists**

If the existing test lists all codes in an array and asserts `codes.length === 17`, expand to:

```ts
const codes: ErrorCode[] = [
  'OWNERSHIP_VIOLATION', 'UNMAPPED_PATH', 'INVALID_FRONTMATTER',
  'INVALID_FILENAME', 'INVALID_OWNER', 'IMMUTABLE_TARGET',
  'JOURNAL_IMMUTABLE', 'NOTE_NOT_FOUND', 'WIKILINK_TARGET_MISSING',
  'GIT_LOCK_BUSY', 'GIT_PUSH_FAILED', 'VAULT_IO_ERROR',
  'LEAD_NOT_FOUND', 'MALFORMED_LEAD_BODY',
  'BROKER_NOT_FOUND', 'MALFORMED_BROKER_BODY', 'INVALID_TIME_RANGE',
  'INVALID_PERIOD', 'SNAPSHOT_NOT_FOUND',
];
expect(codes.length).toBe(19);
```

- [ ] **Step 4: Run test — expect PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/errors.test.ts
```

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/errors.ts mcp-obsidian/test/unit/errors.test.ts
git -C /root/mcp-fama commit -m "feat(errors): add INVALID_PERIOD, SNAPSHOT_NOT_FOUND"
```

### Task A2: Add `financial-snapshot` to frontmatter schema

**Files:** `src/vault/frontmatter.ts`, `test/unit/frontmatter.test.ts`

- [ ] **Step 1: Write failing tests**

In `test/unit/frontmatter.test.ts`, add a new `describe` block at the end. Use this code verbatim:

```ts
describe('financial-snapshot frontmatter branch', () => {
  it('accepts valid financial-snapshot with all optional resumo fields', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
period: 2026-04
caixa_resumo: fluxo confortável
receita_resumo: 78% da meta
despesa_resumo: dentro do orçado
alertas_count: 2
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).type).toBe('financial-snapshot');
    expect((r.frontmatter as any).period).toBe('2026-04');
    expect((r.frontmatter as any).caixa_resumo).toBe('fluxo confortável');
    expect((r.frontmatter as any).alertas_count).toBe(2);
  });

  it('rejects financial-snapshot without period', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
---
body`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('rejects financial-snapshot with period not YYYY-MM', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
period: 2026/04
---
body`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });

  it('accepts financial-snapshot without any resumo field', () => {
    const src = `---
type: financial-snapshot
owner: cfo-exec
created: 2026-04-01
updated: 2026-04-16
tags: []
period: 2026-04
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).type).toBe('financial-snapshot');
    expect((r.frontmatter as any).period).toBe('2026-04');
    expect((r.frontmatter as any).caixa_resumo).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (type not in enum)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/frontmatter.test.ts
```

- [ ] **Step 3: Update `src/vault/frontmatter.ts`**

Make three changes to `src/vault/frontmatter.ts`:

**Change 1:** Extend the `FRONTMATTER_TYPES` tuple by adding `'financial-snapshot'`:

Current (lines 6-11):
```ts
export const FRONTMATTER_TYPES = [
  'moc','context','agents-map','goal','goals-index',
  'result','results-index','agent-readme','agent-profile',
  'agent-decisions','journal','project-readme',
  'shared-context','entity-profile',
] as const;
```

Replace with:
```ts
export const FRONTMATTER_TYPES = [
  'moc','context','agents-map','goal','goals-index',
  'result','results-index','agent-readme','agent-profile',
  'agent-decisions','journal','project-readme',
  'shared-context','entity-profile','financial-snapshot',
] as const;
```

**Change 2:** Add `FinancialSnapshotSchema` immediately after `EntityProfileSchema` (around line 72, before `TYPE_TO_SCHEMA`):

```ts
const FinancialSnapshotSchema = BaseSchema.extend({
  type: z.literal('financial-snapshot'),
  period: z.string().regex(periodRe, 'period must be YYYY-MM'),
  caixa_resumo: z.string().refine(s => !s.includes('\n'), 'caixa_resumo must be one line').optional(),
  receita_resumo: z.string().refine(s => !s.includes('\n'), 'receita_resumo must be one line').optional(),
  despesa_resumo: z.string().refine(s => !s.includes('\n'), 'despesa_resumo must be one line').optional(),
  alertas_count: z.number().int().nonnegative().optional(),
});
```

**Change 3:** Register the schema in `TYPE_TO_SCHEMA`. Current:
```ts
const TYPE_TO_SCHEMA: Record<string, z.ZodTypeAny> = {
  journal: JournalSchema,
  goal: GoalResultSchema,
  result: GoalResultSchema,
  'shared-context': SharedContextSchema,
  'entity-profile': EntityProfileSchema,
};
```

Replace with:
```ts
const TYPE_TO_SCHEMA: Record<string, z.ZodTypeAny> = {
  journal: JournalSchema,
  goal: GoalResultSchema,
  result: GoalResultSchema,
  'shared-context': SharedContextSchema,
  'entity-profile': EntityProfileSchema,
  'financial-snapshot': FinancialSnapshotSchema,
};
```

- [ ] **Step 4: Run — expect 4/4 PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/frontmatter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/frontmatter.ts mcp-obsidian/test/unit/frontmatter.test.ts
git -C /root/mcp-fama commit -m "feat(frontmatter): add financial-snapshot type + schema (§5.9)"
```

---

## Phase B — Body parser/serializer

### Task B1: Write failing parser unit tests

**Files:** `test/unit/financial.test.ts` (NEW)

- [ ] **Step 1: Create the test file**

```ts
// test/unit/financial.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseFinancialBody,
  serializeFinancialBody,
  extractFirstLine,
} from '../../src/vault/financial.js';

describe('parseFinancialBody', () => {
  it('extracts all 5 sections from canonical body', () => {
    const body = `## Caixa
Fluxo confortável, fechamento do mês confirmado.

## Receita
78% da meta. Driver: Union Vista.

## Despesa
Dentro do orçado; CAC -3% vs orçamento.

## Alertas
- Fluxo crítico em maio se 2 fechamentos não saírem
- CAC estourou 12%

## Contexto adicional
Mês com evento não-recorrente de comissão.
`;
    const r = parseFinancialBody(body);
    expect(r.caixa).toContain('confortável');
    expect(r.receita).toContain('78%');
    expect(r.despesa).toContain('orçado');
    expect(r.alertas).toEqual([
      'Fluxo crítico em maio se 2 fechamentos não saírem',
      'CAC estourou 12%',
    ]);
    expect(r.contexto).toContain('evento');
  });

  it('returns null for absent sections (graceful degradation)', () => {
    const body = `## Caixa
Apertado.
`;
    const r = parseFinancialBody(body);
    expect(r.caixa).toBe('Apertado.');
    expect(r.receita).toBeNull();
    expect(r.despesa).toBeNull();
    expect(r.alertas).toBeNull();
    expect(r.contexto).toBeNull();
  });

  it('returns [] for Alertas section present but no items', () => {
    const body = `## Alertas

## Contexto adicional
Tranquilo.
`;
    const r = parseFinancialBody(body);
    expect(r.alertas).toEqual([]);
    expect(r.contexto).toBe('Tranquilo.');
  });

  it('returns all-null for empty body', () => {
    const r = parseFinancialBody('');
    expect(r.caixa).toBeNull();
    expect(r.receita).toBeNull();
    expect(r.despesa).toBeNull();
    expect(r.alertas).toBeNull();
    expect(r.contexto).toBeNull();
  });
});

describe('extractFirstLine', () => {
  it('returns first non-empty trimmed line', () => {
    expect(extractFirstLine('\n\n  fluxo confortável  \nsecond line')).toBe('fluxo confortável');
  });
  it('returns null for all-whitespace input', () => {
    expect(extractFirstLine('\n   \n\t\n')).toBeNull();
  });
  it('returns null for null input', () => {
    expect(extractFirstLine(null)).toBeNull();
  });
});

describe('serializeFinancialBody', () => {
  it('emits 5 sections in canonical order', () => {
    const body = serializeFinancialBody({
      caixa: 'Apertado.',
      receita: '78% da meta.',
      despesa: 'OK.',
      alertas: ['Alerta 1', 'Alerta 2'],
      contexto: 'Tranquilo.',
    });
    // Section order matters
    const idxCaixa = body.indexOf('## Caixa');
    const idxReceita = body.indexOf('## Receita');
    const idxDespesa = body.indexOf('## Despesa');
    const idxAlertas = body.indexOf('## Alertas');
    const idxContexto = body.indexOf('## Contexto adicional');
    expect(idxCaixa).toBeGreaterThanOrEqual(0);
    expect(idxReceita).toBeGreaterThan(idxCaixa);
    expect(idxDespesa).toBeGreaterThan(idxReceita);
    expect(idxAlertas).toBeGreaterThan(idxDespesa);
    expect(idxContexto).toBeGreaterThan(idxAlertas);
    expect(body).toContain('- Alerta 1');
    expect(body).toContain('- Alerta 2');
  });

  it('omits null sections cleanly', () => {
    const body = serializeFinancialBody({
      caixa: 'Apertado.',
      receita: null,
      despesa: null,
      alertas: null,
      contexto: null,
    });
    expect(body).toContain('## Caixa');
    expect(body).not.toContain('## Receita');
    expect(body).not.toContain('## Alertas');
    expect(body).not.toContain('## Contexto adicional');
  });

  it('emits empty Alertas section when alertas is []', () => {
    const body = serializeFinancialBody({
      caixa: null, receita: null, despesa: null,
      alertas: [],
      contexto: null,
    });
    expect(body).toContain('## Alertas');
    expect(body).not.toContain('- ');
  });

  it('round-trip: serialize → parse returns same sections', () => {
    const sections = {
      caixa: 'Apertado mas ok.',
      receita: '78% da meta.',
      despesa: 'Dentro.',
      alertas: ['A', 'B'],
      contexto: 'Notas livres.',
    };
    const body = serializeFinancialBody(sections);
    const parsed = parseFinancialBody(body);
    expect(parsed.caixa).toBe(sections.caixa);
    expect(parsed.receita).toBe(sections.receita);
    expect(parsed.despesa).toBe(sections.despesa);
    expect(parsed.alertas).toEqual(sections.alertas);
    expect(parsed.contexto).toBe(sections.contexto);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/financial.test.ts
```

### Task B2: Implement the parser/serializer

**Files:** `src/vault/financial.ts` (NEW)

- [ ] **Step 1: Write the parser and serializer**

```ts
// src/vault/financial.ts

export interface FinancialSections {
  caixa: string | null;
  receita: string | null;
  despesa: string | null;
  alertas: string[] | null;
  contexto: string | null;
}

const SECTION_RE = /^##\s+(.+?)\s*$/;

function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function parseFinancialBody(body: string): FinancialSections {
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

  const alertasLines = sections['alertas'];
  let alertas: string[] | null = null;
  if (alertasLines) {
    alertas = alertasLines
      .map(l => l.match(/^-\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => m[1].trim());
  }

  return {
    caixa: getText('caixa'),
    receita: getText('receita'),
    despesa: getText('despesa'),
    alertas,
    contexto: getText('contexto adicional'),
  };
}

export function extractFirstLine(section: string | null): string | null {
  if (section === null) return null;
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return null;
}

export function serializeFinancialBody(sections: FinancialSections): string {
  const parts: string[] = [];
  if (sections.caixa !== null)    parts.push(`## Caixa\n${sections.caixa}`);
  if (sections.receita !== null)  parts.push(`## Receita\n${sections.receita}`);
  if (sections.despesa !== null)  parts.push(`## Despesa\n${sections.despesa}`);
  if (sections.alertas !== null) {
    const items = sections.alertas.map(a => `- ${a}`).join('\n');
    parts.push(`## Alertas${items ? '\n' + items : ''}`);
  }
  if (sections.contexto !== null) parts.push(`## Contexto adicional\n${sections.contexto}`);
  return parts.join('\n\n') + (parts.length > 0 ? '\n' : '');
}
```

- [ ] **Step 2: Run — expect all PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/unit/financial.test.ts
```

- [ ] **Step 3: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/financial.ts mcp-obsidian/test/unit/financial.test.ts
git -C /root/mcp-fama commit -m "feat(vault): add financial-snapshot body parser/serializer (§5.9)"
```

---

## Phase C — Tools

### Task C1: Write failing integration tests for upsert + read

**Files:** `test/integration/financial-workflow.test.ts` (NEW)

- [ ] **Step 1: Create the test file**

```ts
// test/integration/financial-workflow.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import {
  upsertFinancialSnapshot,
  readFinancialSeries,
} from '../../src/tools/workflows.js';

describe('financial-snapshot workflow', () => {
  let tmp: string;
  let ctx: any;

  const setupVault = async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fin-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      [
        '```',
        '_shared/financials/*/cfo-exec.md => cfo-exec',
        '_shared/financials/*/ceo-exec.md => ceo-exec',
        '```',
      ].join('\n'),
    );
    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  };

  beforeAll(setupVault);
  beforeEach(setupVault);

  it('creates snapshot with all 5 sections + auto-extracts *_resumo + auto-counts alertas', async () => {
    const r = await upsertFinancialSnapshot(
      {
        as_agent: 'cfo-exec',
        period: '2026-04',
        caixa: 'Fluxo confortável, fechamento confirmado.',
        receita: '78% da meta. Driver: Union Vista.',
        despesa: 'Dentro do orçado; CAC -3%.',
        alertas: ['Fluxo crítico maio', 'CAC estourou 12%'],
        contexto: 'Evento não-recorrente de comissão.',
      },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.path).toBe('_shared/financials/2026-04/cfo-exec.md');
    expect(sc.created_or_updated).toBe('created');

    // Verify frontmatter injection
    const raw = fs.readFileSync(path.join(tmp, sc.path), 'utf8');
    expect(raw).toContain("type: financial-snapshot");
    expect(raw).toContain("period: '2026-04'");
    expect(raw).toContain('alertas_count: 2');
    expect(raw).toMatch(/caixa_resumo: Fluxo confortável/);
    expect(raw).toMatch(/receita_resumo: 78% da meta\./);
    expect(raw).toMatch(/despesa_resumo: Dentro do orçado;/);
  });

  it('rejects bad period with INVALID_PERIOD', async () => {
    const r = await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-13', caixa: 'x' },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_PERIOD');
  });

  it('rejects *_resumo with newline via INVALID_FRONTMATTER', async () => {
    const r = await upsertFinancialSnapshot(
      {
        as_agent: 'cfo-exec',
        period: '2026-04',
        caixa: 'x',
        caixa_resumo: 'line1\nline2',
      },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('INVALID_FRONTMATTER');
  });

  it('update merges: fields not passed keep prior values', async () => {
    // First: create with caixa + receita
    await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', caixa: 'v1 caixa.', receita: 'v1 receita.' },
      ctx,
    );
    // Update with only despesa → caixa/receita must persist
    const r = await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', despesa: 'v1 despesa.' },
      ctx,
    );
    expect((r as any).structuredContent.created_or_updated).toBe('updated');
    const read = await readFinancialSeries(
      { as_agent: 'cfo-exec', periods: ['2026-04'] },
      ctx,
    );
    const snap = (read as any).structuredContent.snapshots[0];
    expect(snap.caixa).toBe('v1 caixa.');
    expect(snap.receita).toBe('v1 receita.');
    expect(snap.despesa).toBe('v1 despesa.');
  });

  it('clears a section when empty string is passed', async () => {
    await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', caixa: 'v1.', receita: 'v1.' },
      ctx,
    );
    await upsertFinancialSnapshot(
      { as_agent: 'cfo-exec', period: '2026-04', caixa: '' },
      ctx,
    );
    const read = await readFinancialSeries(
      { as_agent: 'cfo-exec', periods: ['2026-04'] },
      ctx,
    );
    const snap = (read as any).structuredContent.snapshots[0];
    expect(snap.caixa).toBeNull();
    expect(snap.receita).toBe('v1.');
  });

  it('read with since/until lexicographic range returns desc order', async () => {
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-02', caixa: 'fev' }, ctx);
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-03', caixa: 'mar' }, ctx);
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-04', caixa: 'abr' }, ctx);
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-05', caixa: 'mai' }, ctx);

    const r = await readFinancialSeries(
      { as_agent: 'cfo-exec', since: '2026-03', until: '2026-04' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.snapshots).toHaveLength(2);
    expect(sc.snapshots[0].period).toBe('2026-04');
    expect(sc.snapshots[1].period).toBe('2026-03');
  });

  it('read with explicit periods[] missing entry throws SNAPSHOT_NOT_FOUND', async () => {
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-04', caixa: 'abr' }, ctx);
    const r = await readFinancialSeries(
      { as_agent: 'cfo-exec', periods: ['2026-04', '2026-03'] },
      ctx,
    );
    expect((r as any).structuredContent.error.code).toBe('SNAPSHOT_NOT_FOUND');
  });

  it('read with since/until silently omits missing periods', async () => {
    // Only 2026-04 exists in this range
    await upsertFinancialSnapshot({ as_agent: 'cfo-exec', period: '2026-04', caixa: 'abr' }, ctx);
    const r = await readFinancialSeries(
      { as_agent: 'cfo-exec', since: '2026-01', until: '2026-06' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.snapshots).toHaveLength(1);
    expect(sc.snapshots[0].period).toBe('2026-04');
  });
});
```

- [ ] **Step 2: Run — expect FAIL (handlers not exported yet)**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/financial-workflow.test.ts
```

### Task C2: Implement handlers

**Files:** `src/tools/workflows.ts`

- [ ] **Step 1: Add imports at the top of `src/tools/workflows.ts`**

Locate the existing imports block. Add import for the financial helpers after the `regressao.js` import (added in Plan 5):

```ts
import { parseFinancialBody, serializeFinancialBody, extractFirstLine, type FinancialSections } from '../vault/financial.js';
```

- [ ] **Step 2: Add the upsert handler at the end of `src/tools/workflows.ts` (after the Broker section, before the final `// ─── …` separator if any)**

Append this block:

```ts
// ─── upsert_financial_snapshot + read_financial_series ───────────────────────

const periodReFinancial = /^\d{4}-(0[1-9]|1[0-2])$/;

export const UpsertFinancialSnapshotSchema = z.object({
  as_agent: z.string().min(1),
  period: z.string(),
  caixa: z.string().optional(),
  receita: z.string().optional(),
  despesa: z.string().optional(),
  alertas: z.array(z.string()).optional(),
  contexto: z.string().optional(),
  caixa_resumo: z.string().optional(),
  receita_resumo: z.string().optional(),
  despesa_resumo: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export async function upsertFinancialSnapshot(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertFinancialSnapshotSchema.parse(args);
    if (!periodReFinancial.test(a.period)) {
      throw new McpError('INVALID_PERIOD', `period must be YYYY-MM (got '${a.period}')`);
    }
    for (const key of ['caixa_resumo', 'receita_resumo', 'despesa_resumo'] as const) {
      const v = (a as any)[key];
      if (typeof v === 'string' && v.includes('\n')) {
        throw new McpError('INVALID_FRONTMATTER', `${key} must be one line (no newline)`);
      }
    }

    const rel = `_shared/financials/${a.period}/${a.as_agent}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);

    // Load prior sections if update
    let priorFm: Record<string, any> | null = null;
    let priorSections: FinancialSections = { caixa: null, receita: null, despesa: null, alertas: null, contexto: null };
    if (existing) {
      const { content } = await readFileAtomic(safe);
      const parsed = parseFrontmatter(content);
      priorFm = parsed.frontmatter;
      priorSections = parseFinancialBody(parsed.body);
    }

    // Merge: undefined → keep prior; provided → override
    const merged: FinancialSections = {
      caixa:    a.caixa    !== undefined ? (a.caixa    === '' ? null : a.caixa)    : priorSections.caixa,
      receita:  a.receita  !== undefined ? (a.receita  === '' ? null : a.receita)  : priorSections.receita,
      despesa:  a.despesa  !== undefined ? (a.despesa  === '' ? null : a.despesa)  : priorSections.despesa,
      alertas:  a.alertas  !== undefined ? a.alertas                                : priorSections.alertas,
      contexto: a.contexto !== undefined ? (a.contexto === '' ? null : a.contexto) : priorSections.contexto,
    };

    // Auto-extract *_resumo from merged body if not explicitly passed; else use prior fm
    const caixaResumo = a.caixa_resumo !== undefined
      ? (a.caixa_resumo === '' ? null : a.caixa_resumo)
      : (a.caixa !== undefined
          ? extractFirstLine(merged.caixa)
          : (priorFm?.caixa_resumo ?? extractFirstLine(merged.caixa)));
    const receitaResumo = a.receita_resumo !== undefined
      ? (a.receita_resumo === '' ? null : a.receita_resumo)
      : (a.receita !== undefined
          ? extractFirstLine(merged.receita)
          : (priorFm?.receita_resumo ?? extractFirstLine(merged.receita)));
    const despesaResumo = a.despesa_resumo !== undefined
      ? (a.despesa_resumo === '' ? null : a.despesa_resumo)
      : (a.despesa !== undefined
          ? extractFirstLine(merged.despesa)
          : (priorFm?.despesa_resumo ?? extractFirstLine(merged.despesa)));
    const alertasCount = merged.alertas !== null ? merged.alertas.length : 0;

    const fm: Record<string, any> = {
      type: 'financial-snapshot',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags ?? priorFm?.tags ?? [],
      period: a.period,
      alertas_count: alertasCount,
    };
    if (caixaResumo   !== null) fm.caixa_resumo   = caixaResumo;
    if (receitaResumo !== null) fm.receita_resumo = receitaResumo;
    if (despesaResumo !== null) fm.despesa_resumo = despesaResumo;

    const body = serializeFinancialBody(merged);
    await writeFileAtomic(safe, serializeFrontmatter(fm, body));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_financial_snapshot', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const ReadFinancialSeriesSchema = z.object({
  as_agent: z.string().min(1),
  periods: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().optional().default(12),
  order: z.enum(['desc', 'asc']).optional().default('desc'),
});

export async function readFinancialSeries(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadFinancialSeriesSchema.parse(args);

    // Validate period-shaped filters when provided (since/until or explicit periods)
    const validatePeriodStr = (p: string, field: string) => {
      if (!periodReFinancial.test(p)) {
        throw new McpError('INVALID_PERIOD', `${field} must be YYYY-MM (got '${p}')`);
      }
    };
    if (a.since)  validatePeriodStr(a.since,  'since');
    if (a.until)  validatePeriodStr(a.until,  'until');
    if (a.periods) for (const p of a.periods) validatePeriodStr(p, 'periods[]');
    if (a.since && a.until && a.since > a.until) {
      throw new McpError('INVALID_TIME_RANGE', `since (${a.since}) must be <= until (${a.until})`);
    }

    // Mode (a): explicit periods[] → each must exist or SNAPSHOT_NOT_FOUND
    let selectedPeriods: string[];
    if (a.periods) {
      const missing: string[] = [];
      const found: string[] = [];
      for (const p of a.periods) {
        const rel = `_shared/financials/${p}/${a.as_agent}.md`;
        if (ctx.index.get(rel)) found.push(p); else missing.push(p);
      }
      if (missing.length > 0) {
        throw new McpError('SNAPSHOT_NOT_FOUND', `Missing snapshots for ${a.as_agent}: ${missing.join(', ')}`);
      }
      selectedPeriods = found;
      if (a.since)  selectedPeriods = selectedPeriods.filter(p => p >= a.since!);
      if (a.until)  selectedPeriods = selectedPeriods.filter(p => p <= a.until!);
    } else {
      // Mode (b): scan index for all financials for as_agent; filter by since/until
      const prefix = '_shared/financials/';
      const suffix = `/${a.as_agent}.md`;
      const all: string[] = [];
      for (const e of ctx.index.allEntries()) {
        if (!e.path.startsWith(prefix) || !e.path.endsWith(suffix)) continue;
        const period = e.path.slice(prefix.length, e.path.length - suffix.length);
        if (!periodReFinancial.test(period)) continue;
        all.push(period);
      }
      selectedPeriods = all;
      if (a.since) selectedPeriods = selectedPeriods.filter(p => p >= a.since!);
      if (a.until) selectedPeriods = selectedPeriods.filter(p => p <= a.until!);
    }

    // Sort lexicographic + order
    selectedPeriods.sort();
    if (a.order === 'desc') selectedPeriods.reverse();
    selectedPeriods = selectedPeriods.slice(0, a.limit);

    // Parse each snapshot
    const snapshots: any[] = [];
    for (const period of selectedPeriods) {
      const rel = `_shared/financials/${period}/${a.as_agent}.md`;
      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, rel))); }
      catch { continue; }
      const parsed = parseFrontmatter(content);
      const sections = parseFinancialBody(parsed.body);
      snapshots.push({
        period,
        frontmatter: parsed.frontmatter,
        caixa: sections.caixa,
        receita: sections.receita,
        despesa: sections.despesa,
        alertas: sections.alertas,
        contexto: sections.contexto,
      });
    }

    return { snapshots };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Financial series for ${(args as any).as_agent}: ${v.snapshots.length} snapshot(s)`);
}
```

- [ ] **Step 2: Run — expect 8/8 PASS**

```bash
cd /root/mcp-fama/mcp-obsidian
npx vitest run test/integration/financial-workflow.test.ts
```

- [ ] **Step 3: Typecheck**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/financial-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(workflows): add upsert_financial_snapshot + read_financial_series (§5.9)"
```

---

## Phase D — Server + e2e

### Task D1: Register tools and bump e2e count

**Files:** `src/server.ts`, `test/e2e/smoke.test.ts`

- [ ] **Step 1: Register 2 new tools in `src/server.ts`**

Locate the `get_training_target_delta:` registry line (added in Plan 5). Insert the 2 new lines **immediately after** it (grouping financial tools together). Match the alignment style of neighboring rows:

```ts
  upsert_financial_snapshot: { schema: wf.UpsertFinancialSnapshotSchema, handler: wf.upsertFinancialSnapshot, desc: 'Upsert a financial-snapshot for a period (§5.9)', annotations: { idempotentHint: true, openWorldHint: false } },
  read_financial_series:     { schema: wf.ReadFinancialSeriesSchema,     handler: wf.readFinancialSeries,     desc: 'Read financial-snapshot series for an agent',   annotations: { readOnlyHint: true, openWorldHint: false } },
```

- [ ] **Step 2: Bump e2e smoke from 30 → 32**

In `test/e2e/smoke.test.ts`, line 79-82 currently says `30`. Bump both occurrences to `32`:

```ts
  it('initialize + tools/list returns 32 tools', async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 's', version: '0' } });
    const r = await rpc('tools/list', {});
    expect(r.result.tools.length).toBe(32);
  });
```

- [ ] **Step 3: Typecheck + non-e2e tests**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
npx vitest run --exclude 'test/e2e/**'
```

Expected: typecheck clean; all tests pass (including new 4 frontmatter + 7 financial parser + 8 integration = 19 new cases).

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/server.ts mcp-obsidian/test/e2e/smoke.test.ts
git -C /root/mcp-fama commit -m "feat(server): register financial-snapshot tools (32 tools)"
```

---

## Phase E — Docs

### Task E1: Update README

**Files:** `README.md`

- [ ] **Step 1: Bump plans banner and quickstart**

Replace the "Plans 1-5" block with:

```
This repo implements **Plans 1-6** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`:
- **Plan 1** (Foundation + Core): HTTP transport, auth, vault layer (fs, frontmatter, ownership, index, git), 22 tools + 2 resources.
- **Plan 2** (Lead pattern for Reno): `entity_type=lead` first-class with 3 tools and §5.5 body convention.
- **Plan 3** (Broker pattern for FamaAgent + temporal filters): `entity_type=broker` first-class with 3 tools and §5.6 body convention. `since`/`until` temporal filters on `list_folder`/`search_content`/`search_by_tag`/`search_by_type`. §5.7 broker isolation convention.
- **Plan 4** (Follow-up heartbeat): `get_shared_context_delta(since, topics?, owners?)` cross-agent read grouped by topic. §5.8 canonical 6-topic taxonomy documented as convention (opt-out, objecoes, retomadas, aprendizados, abordagens, regressoes).
- **Plan 5** (Sparring training-target): `get_training_target_delta(target_agent, since, topics?)` composed read — target's own delta + shared-contexts (from other owners) mentioning target via `#alvo-<target>` or body field + `regressoes/` projection with parsed status/severidade/categoria.
- **Plan 6** (cfo-exec financial snapshots): `type: financial-snapshot` with `upsert_financial_snapshot` + `read_financial_series`. Path `_shared/financials/<period>/<agent>.md`. §5.9 body convention (Caixa/Receita/Despesa/Alertas/Contexto adicional) + auto-extracted `*_resumo` fields + auto-counted `alertas_count`.

Plans 7 adds executive broker views (ceo-exec).
```

Quickstart expected output changes from `30` to `32`.

- [ ] **Step 2: Bump `## Tools (30)` → `## Tools (32)` and `### Workflows — generic (14)` → `### Workflows — generic (16)`**

- [ ] **Step 3: Add 2 new tool rows under "Workflows — generic"**

Insert **immediately after** the `get_training_target_delta` row added in Plan 5:

```
| `upsert_financial_snapshot` | `(as_agent, period (YYYY-MM), caixa?, receita?, despesa?, alertas?, contexto?, caixa_resumo?, receita_resumo?, despesa_resumo?, tags?)` | `_shared/financials/<period>/<as_agent>.md` — merges with prior; auto-extracts `*_resumo` from first non-empty body line; auto-counts `alertas_count` |
| `read_financial_series` | `(as_agent, periods?, since?, until?, limit?=12, order?='desc')` | (read) parsed 5-section series. Explicit `periods[]` missing → `SNAPSHOT_NOT_FOUND`; `since`/`until` lexicographic YYYY-MM filter (silent omit) |
```

- [ ] **Step 4: Add a new "## Financial snapshots (§5.9)" section after the "## Canonical shared-context topics (§5.8)" section**

Insert:

```
## Financial snapshots (§5.9)

Per-period textual operational snapshots. Path `_shared/financials/<period>/<agent>.md` (period is `YYYY-MM`). Body follows 5 literal sections:

    ## Caixa
    <resumo operacional: fluxo, saldo relativo ao mês anterior>

    ## Receita
    <resumo operacional: % vs meta, drivers>

    ## Despesa
    <resumo operacional: dentro/fora do orçado, principais variações>

    ## Alertas
    - <alerta 1>
    - <alerta 2>

    ## Contexto adicional
    <notas livres sobre o período>

Each snapshot is a **period closure** — rewrite via `upsert_financial_snapshot` as understanding evolves; merge semantics (omitted fields keep prior values, empty string clears). `caixa_resumo`/`receita_resumo`/`despesa_resumo` frontmatter fields auto-extract the first non-empty line of the corresponding body section when not passed explicitly. `alertas_count` auto-computed from array length.

**Governance §1.1 reminder:** textual, qualitative values only (`"fluxo confortável"`, `"78% da meta"`). Numeric detail — R$, contas a pagar/receber, transactions — lives in the official financial system, not in the vault.

### Typical consumption (cfo-exec cross-period analysis)

    read_financial_series(
      as_agent='cfo-exec',
      since='2026-02', until='2026-04',
      order='desc'
    ) → { snapshots: [{period, frontmatter:{caixa_resumo,...}, caixa, receita, despesa, alertas, contexto}, ...] }

Used when the human (Renato) asks trend questions — agent compares sections month-over-month in its own reasoning; MCP does not compute numeric diffs (§10).
```

- [ ] **Step 5: Update Troubleshooting table to include new error codes**

Find the Troubleshooting table in README. Add 2 rows:

```
| `INVALID_PERIOD` | `period` / `since` / `until` not `YYYY-MM` in financial tools | use `YYYY-MM` (e.g. `2026-04`) |
| `SNAPSHOT_NOT_FOUND` | `read_financial_series(periods=[...])` with missing entry | use `since`/`until` for silent omit, or upsert missing period first |
```

- [ ] **Step 6: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/README.md
git -C /root/mcp-fama commit -m "docs(readme): document financial snapshots (§5.9) + 32-tool total"
```

---

## Phase F — Ownership + Deploy + Dogfood

### Task F1: Add financial ownership patterns to production AGENTS.md

**Files:** `/root/fama-brain/_shared/context/AGENTS.md`

> **Handled by the human operator / deploy phase, NOT by the subagent.** This edit is to the production vault (which is a shared system). It must land before the Docker service can accept writes to `_shared/financials/…`.

- [ ] **Step 1: Read existing ownership patterns**

```bash
cat /root/fama-brain/_shared/context/AGENTS.md | grep -A2 '^_shared/results'
```

- [ ] **Step 2: Add 4 new ownership patterns under the existing `_shared/results` block**

Append (inside the same fenced code block, preserving the trailing structure) these lines after the results section:

```
_shared/financials/*/ceo.md      => ceo
_shared/financials/*/cfo.md      => cfo
_shared/financials/*/ceo-exec.md => ceo-exec
_shared/financials/*/cfo-exec.md => cfo-exec
```

- [ ] **Step 3: Commit the vault change**

```bash
cd /root/fama-brain
git add _shared/context/AGENTS.md
git commit -m "chore(ownership): add financial ownership patterns (cfo/cfo-exec/ceo/ceo-exec)"
```

The running MCP service hot-reloads the ownership resolver on AGENTS.md mtime change — no restart required for ownership to take effect.

### Task F2: Build + deploy

- [ ] **Step 1: Build TypeScript**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run build
grep -c "upsertFinancialSnapshot\|readFinancialSeries" dist/tools/workflows.js dist/server.js
```

Expected: `dist/tools/workflows.js: ≥2`, `dist/server.js: ≥2`.

- [ ] **Step 2: Build Docker image + force-update Swarm service**

```bash
cd /root/mcp-fama/mcp-obsidian
docker build -t mcp-obsidian:latest .
docker service update --force --image mcp-obsidian:latest mcp-obsidian_mcp-obsidian
```

Expected: `Service mcp-obsidian_mcp-obsidian converged`.

- [ ] **Step 3: Verify live endpoint reports 32 tools**

```bash
API_KEY=$(docker exec $(docker ps -q --filter 'name=mcp-obsidian') sh -c 'cat $API_KEY_FILE')
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 > /tmp/tools.json
python3 -c '
import json
r = json.load(open("/tmp/tools.json"))
t = r["result"]["tools"]
names = [x["name"] for x in t]
print("Total:", len(t))
for tool in ["upsert_financial_snapshot", "read_financial_series"]:
    print(f"Has {tool}: {tool in names}")
'
```

Expected: `Total: 32` + both new tools present.

### Task F3: Dogfood

- [ ] **Step 1: cfo-exec writes a snapshot for 2026-04**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"upsert_financial_snapshot","arguments":{"as_agent":"cfo-exec","period":"2026-04","caixa":"Fluxo confortável; dogfood Plan 6.","receita":"Dogfood run, textual.","despesa":"Dentro do orçado.","alertas":["Dogfood alerta 1","Dogfood alerta 2"],"contexto":"Teste do Plan 6.","tags":["dogfood"]}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"], indent=2))'
```

Expected: `{path: '_shared/financials/2026-04/cfo-exec.md', created_or_updated: 'created'}`.

- [ ] **Step 2: read_financial_series roundtrip**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_financial_series","arguments":{"as_agent":"cfo-exec","periods":["2026-04"]}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c '
import json, sys
r = json.load(sys.stdin)
sc = r["result"]["structuredContent"]
s = sc["snapshots"][0]
print("period:", s["period"])
print("alertas_count (fm):", s["frontmatter"]["alertas_count"])
print("caixa_resumo (fm):", s["frontmatter"].get("caixa_resumo"))
print("alertas (body):", s["alertas"])
'
```

Expected: `period: 2026-04`, `alertas_count (fm): 2`, `caixa_resumo` starts with `Fluxo confortável`, `alertas` list has 2 items.

- [ ] **Step 3: SNAPSHOT_NOT_FOUND test**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_financial_series","arguments":{"as_agent":"cfo-exec","periods":["2026-04","2026-03"]}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"].get("error", r["result"]["structuredContent"]), indent=2))'
```

Expected: `{code: 'SNAPSHOT_NOT_FOUND', ...}`.

- [ ] **Step 4: INVALID_PERIOD test**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"upsert_financial_snapshot","arguments":{"as_agent":"cfo-exec","period":"2026-13","caixa":"x"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"].get("error", r["result"]["structuredContent"]), indent=2))'
```

Expected: `{code: 'INVALID_PERIOD', ...}`.

- [ ] **Step 5: Cleanup the dogfood snapshot**

```bash
curl -s -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST https://mcp-obsidian.famachat.com.br/mcp -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"delete_note","arguments":{"path":"_shared/financials/2026-04/cfo-exec.md","as_agent":"cfo-exec","reason":"dogfood cleanup Plan 6"}}}' | grep -oE '(^\{|data: \{.*)' | sed 's/^data: //' | head -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r["result"]["structuredContent"], indent=2))'
```

Expected: `{deleted: true, path: '_shared/financials/2026-04/cfo-exec.md'}`.

---

## Self-Review Checklist

- [ ] **Spec coverage:**
  - §4.2 rows `upsert_financial_snapshot` + `read_financial_series` → Phase C Task C2.
  - §4.5 annotations (`readOnlyHint` on read, `idempotentHint` on upsert) → Phase D Task D1 registry entries.
  - §5.1 `financial-snapshot` frontmatter branch → Phase A Task A2.
  - §5.4 ownership patterns (`_shared/financials/*/<agent>.md`) → Phase F Task F1.
  - §5.9 body convention (5 sections, Alertas as list, auto-resumo, alertas_count, merge semantics) → Phase B + Phase C.
  - §6.2 errors `INVALID_PERIOD` + `SNAPSHOT_NOT_FOUND` → Phase A Task A1.
  - §7 performance targets `< 100ms` upsert/read → honored by indexed path lookup (no full-index scan; `ctx.index.get(rel)` is O(1) Map lookup; scan branch in `since/until` mode filters by path prefix before parse).
  - §1.1 governance textual-only reminder → documented in README (Phase E Task E1 Step 4).
- [ ] **Placeholder scan:** All tests are concrete; all schema/handler/parser code is concrete; all README additions are concrete; no TBD/TODO.
- [ ] **Type consistency:** `FinancialSections` return type (Phase B) matches what Phase C consumes and what integration tests assert. `UpsertFinancialSnapshotSchema` fields match §4.2 row. `readFinancialSeries` return shape matches §4.2 row (`{snapshots: [{period, frontmatter, caixa, receita, despesa, alertas, contexto}]}`). `periodReFinancial = /^\d{4}-(0[1-9]|1[0-2])$/` is stricter than the generic `periodRe` in frontmatter.ts (rejects `2026-13`) — this is intentional since the tool is the runtime boundary, and `INVALID_PERIOD` is the correct error; the frontmatter schema's looser `periodRe` only validates shape of already-serialized fields.
- [ ] **Error paths:** `INVALID_PERIOD` via `!periodReFinancial.test(…)` (Phase C both tools); `SNAPSHOT_NOT_FOUND` via explicit-periods missing (Phase C read). `INVALID_FRONTMATTER` for `*_resumo` containing `\n` (Phase C upsert + enforced at both the schema and tool levels for defense-in-depth).
- [ ] **Count invariant:** 30 → 32 tools (asserted in e2e + README + server registry).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-mcp-obsidian-financial-snapshots.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent for Phases A-E (code + docs), I handle Phase F (ownership + deploy + dogfood — shared system touches).

**2. Inline Execution** — execute tasks in this session with checkpoints.

**Which approach?**
