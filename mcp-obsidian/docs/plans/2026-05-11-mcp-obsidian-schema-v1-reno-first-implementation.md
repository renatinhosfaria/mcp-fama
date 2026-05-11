# MCP Obsidian Schema v1 Reno-First Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Schema v1 validation, Reno-first routed writes, legacy alias handling, trust-aware retrieval, and vault validation for MCP Obsidian.

**Architecture:** Add small shared v1 modules for dates, frontmatter, trust, routing, and index policy, then make CRUD/workflow tools call those helpers before writing. Keep parsing tolerant for legacy reads, but make every v1 tool emit strict Schema v1 frontmatter and valid destinations.

**Tech Stack:** TypeScript, zod, gray-matter, Vitest, Express MCP server, existing `VaultIndex` and atomic filesystem helpers.

---

## Execution Notes

The user explicitly requested no git worktrees. Execute in the current workspace, but do not revert unrelated dirty files. Stage and commit only files touched by each task.

Before each task:

```bash
git status --short
```

After each task, commit the task-specific files only.

---

### Task 1: Config and Error Codes

**Files:**
- Modify: `src/errors.ts`
- Modify: `src/config.ts`
- Modify: `test/unit/errors.test.ts`
- Modify: `test/unit/config.test.ts`

**Step 1: Write failing tests**

Add expectations for new error codes in `test/unit/errors.test.ts`:

```ts
const codes: ErrorCode[] = [
  'OWNERSHIP_VIOLATION',
  'UNMAPPED_PATH',
  'INVALID_FRONTMATTER',
  'LEGACY_NAMESPACE_REMOVED',
  'DEPRECATED_TOOL',
  'ROUTING_VIOLATION',
  'PROTECTED_FIELD_VIOLATION',
  'INVALID_SCHEMA_V1',
  'TRUST_POLICY_VIOLATION',
  // keep existing codes...
];
```

Add config tests in `test/unit/config.test.ts`:

```ts
it('Schema v1 compatibility config defaults', async () => {
  process.env.API_KEY = 'k';
  process.env.VAULT_PATH = '/tmp';
  delete process.env.LEGACY_TOOL_MODE;
  delete process.env.HUMAN_VERIFIERS;
  delete process.env.DEFAULT_AGENT_SOURCE;
  delete process.env.DEFAULT_DATE_STYLE;
  vi.resetModules();
  const mod = await import('../../src/config.js?schema-v1-defaults');
  expect(mod.config.legacyToolMode).toBe('redirect');
  expect(mod.config.humanVerifiers).toEqual([]);
  expect(mod.config.defaultAgentSource).toBe('agent-generated');
  expect(mod.config.defaultDateStyle).toBe('yyyy-mm-dd');
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/unit/errors.test.ts test/unit/config.test.ts
```

Expected: FAIL because codes/config fields are missing.

**Step 3: Implement minimal code**

In `src/errors.ts`, add:

```ts
| 'LEGACY_NAMESPACE_REMOVED'
| 'DEPRECATED_TOOL'
| 'ROUTING_VIOLATION'
| 'PROTECTED_FIELD_VIOLATION'
| 'INVALID_SCHEMA_V1'
| 'TRUST_POLICY_VIOLATION'
```

In `src/config.ts`, add:

```ts
function parseCsv(name: string): string[] {
  return optional(name, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseLegacyToolMode(): 'redirect' | 'error' {
  const v = optional('LEGACY_TOOL_MODE', 'redirect');
  if (v !== 'redirect' && v !== 'error') throw new Error(`LEGACY_TOOL_MODE must be redirect or error`);
  return v;
}
```

Then expose:

```ts
legacyToolMode: parseLegacyToolMode(),
humanVerifiers: parseCsv('HUMAN_VERIFIERS'),
defaultAgentSource: optional('DEFAULT_AGENT_SOURCE', 'agent-generated'),
defaultDateStyle: optional('DEFAULT_DATE_STYLE', 'yyyy-mm-dd'),
```

**Step 4: Run tests**

```bash
npm test -- test/unit/errors.test.ts test/unit/config.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/errors.ts src/config.ts test/unit/errors.test.ts test/unit/config.test.ts
git commit -m "feat(config): add schema v1 compatibility settings"
```

---

### Task 2: Schema v1 Date and Frontmatter Helpers

**Files:**
- Create: `src/vault/schema-v1.ts`
- Modify: `src/vault/frontmatter.ts`
- Create: `test/unit/schema-v1.test.ts`
- Modify: `test/unit/frontmatter.test.ts`

**Step 1: Write failing tests**

Create `test/unit/schema-v1.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeDateInput, buildV1Frontmatter, validateV1Frontmatter } from '../../src/vault/schema-v1.js';

describe('schema v1 dates', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(normalizeDateInput('2026-05-11')).toEqual({ date: '2026-05-11' });
  });

  it('accepts ISO-8601 with timezone and derives date', () => {
    expect(normalizeDateInput('2026-05-11T14:30:00-03:00')).toEqual({
      date: '2026-05-11',
      timestamp: '2026-05-11T14:30:00-03:00',
    });
  });
});

describe('schema v1 frontmatter', () => {
  it('builds required common fields and preserves extras', () => {
    const fm = buildV1Frontmatter({
      type: 'journal',
      status: 'active',
      source: 'agent-generated',
      tags: ['reno'],
      author_agent: 'reno',
      extra: 'ok',
    }, '2026-05-11');
    expect(fm.schema_version).toBe(1);
    expect(fm.created).toBe('2026-05-11');
    expect(fm.updated).toBe('2026-05-11');
    expect(fm.extra).toBe('ok');
  });

  it('rejects v1 missing required fields', () => {
    expect(() => validateV1Frontmatter({ schema_version: 1, type: 'journal' })).toThrow(/INVALID_SCHEMA_V1/);
  });
});
```

Add a parser test in `test/unit/frontmatter.test.ts`:

```ts
it('accepts v1 ISO date fields and passthrough extras', () => {
  const r = parseFrontmatter(`---
schema_version: 1
type: interaction
status: active
created: 2026-05-11T14:30:00-03:00
updated: 2026-05-11
source: agent-generated
tags: [reno]
participants: ['[[Bruno]]']
channel: whatsapp
unknown_field: kept
---
body`);
  expect(r.frontmatter?.schema_version).toBe(1);
  expect(r.frontmatter?.unknown_field).toBe('kept');
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/unit/schema-v1.test.ts test/unit/frontmatter.test.ts
```

Expected: FAIL because `schema-v1.ts` does not exist and `frontmatter.ts` still validates dates as `YYYY-MM-DD` only in several schemas.

**Step 3: Implement helper module**

Create `src/vault/schema-v1.ts` with:

```ts
import { z } from 'zod';
import { McpError } from '../errors.js';

export const V1_TYPES = ['interaction','decision','entity','hub','journal','concept','reference','runbook','project','goal','result'] as const;
export const V1_STATUSES = ['draft','active','superseded','archived'] as const;
export const V1_SOURCES = ['human-curated','agent-generated','imported'] as const;

const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeDateInput(input: string): { date: string; timestamp?: string } {
  if (dateOnlyRe.test(input)) return { date: input };
  const ms = Date.parse(input);
  if (Number.isNaN(ms) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(input)) {
    throw new McpError('INVALID_SCHEMA_V1', `Date must be YYYY-MM-DD or ISO-8601 with timezone: ${input}`);
  }
  return { date: input.slice(0, 10), timestamp: input };
}

export const V1CommonSchema = z.object({
  schema_version: z.literal(1),
  type: z.enum(V1_TYPES),
  status: z.enum(V1_STATUSES),
  created: z.string().refine(v => {
    try { normalizeDateInput(v); return true; } catch { return false; }
  }),
  updated: z.string().refine(v => {
    try { normalizeDateInput(v); return true; } catch { return false; }
  }),
  source: z.enum(V1_SOURCES),
  tags: z.array(z.string()),
}).passthrough();

export function validateV1Frontmatter(fm: Record<string, any>): Record<string, any> {
  const result = V1CommonSchema.safeParse(fm);
  if (!result.success) {
    throw new McpError('INVALID_SCHEMA_V1', `Schema v1 invalid: ${result.error.errors.map(e => `${e.path.join('.')}:${e.message}`).join('; ')}`);
  }
  return result.data;
}

export function buildV1Frontmatter(input: Record<string, any>, today: string): Record<string, any> {
  return validateV1Frontmatter({
    schema_version: 1,
    status: input.status ?? 'active',
    created: input.created ?? today,
    updated: today,
    source: input.source ?? 'agent-generated',
    tags: input.tags ?? [],
    ...input,
  });
}
```

Update `src/vault/frontmatter.ts` to use a date field that accepts both date-only and ISO with timezone. For `schema_version: 1`, validate via `validateV1Frontmatter` first and then apply type-specific minimal schemas only where they do not conflict with v1.

**Step 4: Run tests**

```bash
npm test -- test/unit/schema-v1.test.ts test/unit/frontmatter.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/vault/schema-v1.ts src/vault/frontmatter.ts test/unit/schema-v1.test.ts test/unit/frontmatter.test.ts
git commit -m "feat(vault): add schema v1 frontmatter helpers"
```

---

### Task 3: Filename and Legacy Namespace Guards

**Files:**
- Modify: `src/vault/fs.ts`
- Modify: `src/tools/_shared.ts`
- Modify: `src/tools/crud.ts`
- Modify: `test/unit/fs.test.ts`
- Create: `test/unit/legacy-namespace.test.ts`
- Modify: `test/integration/crud.test.ts`

**Step 1: Write failing tests**

Update `test/unit/fs.test.ts` so `README.md` is accepted:

```ts
expect(() => validateFilename('README.md')).not.toThrow();
```

Create `test/unit/legacy-namespace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertNoLegacyNamespaceWrite } from '../../src/tools/_shared.js';

describe('assertNoLegacyNamespaceWrite', () => {
  it('rejects any _agents write before ownership', () => {
    expect(() => assertNoLegacyNamespaceWrite('_agents/reno/foo.md')).toThrow(/LEGACY_NAMESPACE_REMOVED/);
  });

  it('allows v1 destinations', () => {
    expect(() => assertNoLegacyNamespaceWrite('_journal/reno/foo.md')).not.toThrow();
  });
});
```

Add integration tests in `test/integration/crud.test.ts`:

```ts
it('write_note blocks _agents even for vault_admin', async () => {
  const r = await writeNote({
    path: '_agents/alfa/new.md',
    content: 'x',
    frontmatter: { type: 'journal', owner: 'alfa', created: '2026-05-11', updated: '2026-05-11', tags: [] },
    as_agent: 'vault_admin',
  }, ctx);
  expect((r.structuredContent as any).error.code).toBe('LEGACY_NAMESPACE_REMOVED');
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/unit/fs.test.ts test/unit/legacy-namespace.test.ts test/integration/crud.test.ts
```

Expected: FAIL because `README.md` and the new guard are not implemented.

**Step 3: Implement guard**

In `src/vault/fs.ts`, allow uppercase `README.md`:

```ts
const FILENAME_RE = /^([a-z0-9][a-z0-9-]*|index|readme|README)\.md$/;
```

In `src/tools/_shared.ts`, add:

```ts
export function assertNoLegacyNamespaceWrite(rel: string): void {
  if (/^_agents(?:\/|$)/.test(rel)) {
    throw new McpError(
      'LEGACY_NAMESPACE_REMOVED',
      `Writes to _agents/** are disabled. Use Schema v1 destinations: _entities/, _journal/<agent>/, _runbooks/, _decisions/, _hubs/, or _meta/.`,
      `Use create_journal_event, create_or_update_entity, record_decision, upsert_runbook, or update_hub`,
    );
  }
}
```

In `src/tools/crud.ts`, call `assertNoLegacyNamespaceWrite(a.path)` immediately after parsing in `writeNote`, `appendToNote`, and `deleteNote`, before `ownerCheck`.

**Step 4: Run tests**

```bash
npm test -- test/unit/fs.test.ts test/unit/legacy-namespace.test.ts test/integration/crud.test.ts
```

Expected: PASS for affected tests. If unrelated integration tests still expect legacy writes, update only tests that now violate the new contract.

**Step 5: Commit**

```bash
git add src/vault/fs.ts src/tools/_shared.ts src/tools/crud.ts test/unit/fs.test.ts test/unit/legacy-namespace.test.ts test/integration/crud.test.ts
git commit -m "feat(tools): block legacy agents namespace writes"
```

---

### Task 4: Trust and Index Policy

**Files:**
- Create: `src/vault/trust.ts`
- Create: `src/vault/index-policy.ts`
- Modify: `src/vault/index.ts`
- Modify: `src/tools/crud.ts`
- Modify: `src/tools/workflows.ts`
- Create: `test/unit/trust.test.ts`
- Create: `test/unit/index-policy.test.ts`
- Modify: `test/integration/crud.test.ts`

**Step 1: Write failing tests**

Create `test/unit/trust.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeTrustLevel, passesMinTrust } from '../../src/vault/trust.js';

const humans = ['Renato Faria'];

describe('trust', () => {
  it('classifies human curated notes', () => {
    const t = computeTrustLevel({ source: 'human-curated' }, humans);
    expect(t.trust_level).toBe('human_curated');
    expect(passesMinTrust(t, 'human')).toBe(true);
  });

  it('keeps unverified agent notes out of verified retrieval', () => {
    const t = computeTrustLevel({ source: 'agent-generated', verified_by: null }, humans);
    expect(t.trust_level).toBe('unverified_agent');
    expect(passesMinTrust(t, 'verified')).toBe(false);
  });

  it('distinguishes agent and human verification', () => {
    expect(computeTrustLevel({ source: 'agent-generated', verified_by: 'reno' }, humans).verified_mode).toBe('agent');
    expect(computeTrustLevel({ source: 'agent-generated', verified_by: 'Renato Faria' }, humans).verified_mode).toBe('human');
  });
});
```

Create `test/unit/index-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeIndexPolicy } from '../../src/vault/index-policy.js';

describe('index policy', () => {
  it('vectorizes active entities', () => {
    expect(computeIndexPolicy('_entities/bruno.md', { status: 'active' })).toMatchObject({ vector: true, graph: true });
  });

  it('keeps journal graph-only', () => {
    expect(computeIndexPolicy('_journal/reno/x.md', { status: 'active' })).toMatchObject({ vector: false, graph: true });
  });

  it('draft disables both', () => {
    expect(computeIndexPolicy('_entities/bruno.md', { status: 'draft' })).toMatchObject({ vector: false, graph: false });
  });
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/unit/trust.test.ts test/unit/index-policy.test.ts test/integration/crud.test.ts
```

Expected: FAIL because helpers and index metadata are absent.

**Step 3: Implement helpers**

Create `src/vault/trust.ts`:

```ts
export type MinTrust = 'any' | 'verified' | 'human';
export type TrustLevel = 'unverified_agent' | 'agent_verified' | 'human_verified' | 'human_curated' | 'imported_unknown';

export interface TrustInfo {
  trust_level: TrustLevel;
  verified: boolean;
  verified_mode: 'none' | 'agent' | 'human' | 'source';
}

export function computeTrustLevel(fm: Record<string, any> | null | undefined, humanVerifiers: string[]): TrustInfo {
  if (fm?.source === 'human-curated') return { trust_level: 'human_curated', verified: true, verified_mode: 'source' };
  const verifiedBy = fm?.verified_by;
  const verifier = Array.isArray(verifiedBy) ? verifiedBy[0] : verifiedBy;
  if (typeof verifier === 'string' && verifier.trim()) {
    const mode = humanVerifiers.includes(verifier.trim()) ? 'human' : 'agent';
    return { trust_level: mode === 'human' ? 'human_verified' : 'agent_verified', verified: true, verified_mode: mode };
  }
  if (fm?.source === 'imported') return { trust_level: 'imported_unknown', verified: false, verified_mode: 'none' };
  return { trust_level: 'unverified_agent', verified: false, verified_mode: 'none' };
}

export function passesMinTrust(info: TrustInfo, minTrust: MinTrust): boolean {
  if (minTrust === 'any') return true;
  if (minTrust === 'verified') return info.verified;
  return info.trust_level === 'human_curated' || info.trust_level === 'human_verified';
}
```

Create `src/vault/index-policy.ts`:

```ts
export interface IndexPolicy { vector: boolean; graph: boolean; reason: string; }

export function computeIndexPolicy(rel: string, fm: Record<string, any> | null | undefined): IndexPolicy {
  const status = fm?.status ?? 'active';
  if (status === 'draft') return { vector: false, graph: false, reason: 'status:draft' };
  if (status === 'superseded' || status === 'archived') return { vector: false, graph: true, reason: `status:${status}` };
  if (/^_(entities|hubs|decisions|runbooks)\//.test(rel)) return { vector: true, graph: true, reason: 'folder_rule' };
  if (/^_journal\//.test(rel)) return { vector: false, graph: true, reason: 'folder_rule' };
  if (/^_meta\//.test(rel)) return { vector: false, graph: false, reason: 'folder_rule' };
  return { vector: false, graph: true, reason: 'default_graph' };
}
```

Update `IndexEntry` in `src/vault/index.ts` to include `index_policy`, computed during `indexFile`.

Update search responses in `src/tools/crud.ts` and `src/tools/workflows.ts` to accept `min_trust: 'any' | 'verified' | 'human'`, compute trust from config `humanVerifiers`, and include `trust_level` and `verified_mode`.

**Step 4: Run tests**

```bash
npm test -- test/unit/trust.test.ts test/unit/index-policy.test.ts test/integration/crud.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/vault/trust.ts src/vault/index-policy.ts src/vault/index.ts src/tools/crud.ts src/tools/workflows.ts test/unit/trust.test.ts test/unit/index-policy.test.ts test/integration/crud.test.ts
git commit -m "feat(vault): add trust and index policy metadata"
```

---

### Task 5: `create_journal_event` and `create_journal_entry` Alias

**Files:**
- Modify: `src/tools/workflows.ts`
- Modify: `src/server.ts`
- Modify: `test/integration/workflows.test.ts`

**Step 1: Write failing tests**

Add tests in `test/integration/workflows.test.ts`:

```ts
it('create_journal_event writes Schema v1 journal to _journal/<agent>', async () => {
  const r = await createJournalEvent({
    agent: 'reno',
    title: 'Auditoria diaria',
    content: '# log',
    event_date: '2026-05-10',
    tags: ['operacional'],
  }, ctx);
  const sc = r.structuredContent as any;
  expect(sc.path).toBe('_journal/reno/2026-05-10-auditoria-diaria.md');
  const raw = fs.readFileSync(path.join(FIXTURE, sc.path), 'utf8');
  expect(raw).toContain('schema_version: 1');
  expect(raw).toContain('type: journal');
});

it('create_journal_entry redirects with deprecation metadata', async () => {
  const r = await createJournalEntry({ agent: 'reno', title: 'Atendimento X', content: 'x' }, ctx);
  const sc = r.structuredContent as any;
  expect(sc.deprecated).toBe(true);
  expect(sc.legacy_tool).toBe('create_journal_entry');
  expect(sc.redirected_to).toBe('create_journal_event');
  expect(sc.path).toMatch(/^_journal\/reno\//);
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/integration/workflows.test.ts
```

Expected: FAIL because `createJournalEvent` is missing and legacy tool still writes to `_agents/**`.

**Step 3: Implement tool and alias**

In `src/tools/workflows.ts`, add `CreateJournalEventSchema` and `createJournalEvent`.

Important implementation details:

- Filename uses `event_date` or date derived from `occurred_at`.
- `created` and `updated` use today's vault write date.
- Type is `interaction` only if `channel` and non-empty `participants` are present.
- Call guards in order: parse, `assertNoLegacyNamespaceWrite`, destination/ownership, schema/routing, write.
- For `_journal/<agent>/**`, normal `ownerCheck` should use AGENTS.md. If test fixtures lack `_journal`, update fixtures in tests only as needed.

Add alias helper:

```ts
function withLegacyRedirect(sc: Record<string, any>, legacyTool: string, redirectedTo: string): Record<string, any> {
  return {
    ...sc,
    deprecated: true,
    legacy_tool: legacyTool,
    redirected_to: redirectedTo,
    legacy_tool_mode: config.legacyToolMode,
    new_path: sc.path,
  };
}
```

Make `createJournalEntry`:

- return `DEPRECATED_TOOL` if `config.legacyToolMode === 'error'`;
- otherwise call `createJournalEvent` and wrap response metadata.

Register `create_journal_event` in `src/server.ts`.

**Step 4: Run tests**

```bash
npm test -- test/integration/workflows.test.ts
```

Expected: PASS for journal tests.

**Step 5: Commit**

```bash
git add src/tools/workflows.ts src/server.ts test/integration/workflows.test.ts
git commit -m "feat(workflows): add routed journal events"
```

---

### Task 6: `record_decision` and Deprecated `append_decision`

**Files:**
- Modify: `src/tools/workflows.ts`
- Modify: `src/server.ts`
- Modify: `test/integration/workflows.test.ts`

**Step 1: Write failing tests**

Add tests:

```ts
it('record_decision creates atomic Schema v1 decision', async () => {
  const r = await recordDecision({
    as_agent: 'reno',
    title: 'Followups independentes',
    rationale: 'Evita acoplamento operacional',
    decided_by: ['[[Reno]]'],
    tags: ['operacional'],
  }, ctx);
  const sc = r.structuredContent as any;
  expect(sc.path).toMatch(/^_decisions\/\d{4}-\d{2}-\d{2}-reno-followups-independentes\.md$/);
  const raw = fs.readFileSync(path.join(FIXTURE, sc.path), 'utf8');
  expect(raw).toContain('type: decision');
  expect(raw).toContain('schema_version: 1');
});

it('append_decision always fails and does not write', async () => {
  const before = fs.readFileSync(path.join(FIXTURE, '_agents/alfa/decisions.md'), 'utf8');
  const r = await appendDecision({ agent: 'alfa', title: 'Nova', rationale: 'x' }, ctx);
  expect((r.structuredContent as any).error.code).toBe('DEPRECATED_TOOL');
  const after = fs.readFileSync(path.join(FIXTURE, '_agents/alfa/decisions.md'), 'utf8');
  expect(after).toBe(before);
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/integration/workflows.test.ts
```

Expected: FAIL because `recordDecision` is missing and `appendDecision` still writes.

**Step 3: Implement**

Add `RecordDecisionSchema` and `recordDecision` in `src/tools/workflows.ts`.

Path rule:

```ts
const rel = a.as_agent === 'reno'
  ? `_decisions/${date}-reno-${slug}.md`
  : `_decisions/${date}-${slug}.md`;
```

Frontmatter must include `schema_version: 1`, `type: 'decision'`, `status: 'active'`, `source`, `author_agent`, `decided_by`, `supersedes`, `superseded_by`, `mentions_entity`, `implements`, `related`.

Change `appendDecision` to immediately return:

```ts
new McpError('DEPRECATED_TOOL', `append_decision is removed for Schema v1. Use record_decision to create an atomic note in _decisions/.`, `Use record_decision`)
```

Register `record_decision` in `src/server.ts`.

**Step 4: Run tests**

```bash
npm test -- test/integration/workflows.test.ts
```

Expected: PASS for decision tests.

**Step 5: Commit**

```bash
git add src/tools/workflows.ts src/server.ts test/integration/workflows.test.ts
git commit -m "feat(workflows): record decisions as atomic notes"
```

---

### Task 7: `create_or_update_entity` and `upsert_entity_profile` Alias

**Files:**
- Modify: `src/tools/workflows.ts`
- Modify: `src/server.ts`
- Modify: `src/vault/entity-resolver.ts`
- Modify: `test/unit/entity-resolver.test.ts`
- Create: `test/integration/entity-v1.test.ts`

**Step 1: Write failing tests**

Create `test/integration/entity-v1.test.ts`:

```ts
it('reno creates entity with provenance through controlled tool', async () => {
  const r = await createOrUpdateEntity({
    as_agent: 'reno',
    name: 'Bruno Savio',
    entity_type: 'person',
    content: 'Perfil operacional.',
    external_ids: { famachat_client_id: '123' },
    tags: ['cliente'],
  }, ctx);
  const sc = r.structuredContent as any;
  expect(sc.path).toBe('_entities/bruno-savio.md');
  const raw = fs.readFileSync(path.join(tmp, sc.path), 'utf8');
  expect(raw).toContain('source: agent-generated');
  expect(raw).toContain('author_agent: reno');
});

it('reno cannot change protected existing entity_type', async () => {
  await createOrUpdateEntity({ as_agent: 'reno', name: 'Bruno Savio', entity_type: 'person', content: 'x' }, ctx);
  const r = await createOrUpdateEntity({ as_agent: 'reno', name: 'Bruno Savio', entity_type: 'org', content: 'x' }, ctx);
  expect((r.structuredContent as any).error.code).toBe('PROTECTED_FIELD_VIOLATION');
});

it('upsert_entity_profile redirects to create_or_update_entity', async () => {
  const r = await upsertEntityProfile({ as_agent: 'reno', entity_type: 'person', entity_name: 'Maria X', content: 'x' }, ctx);
  const sc = r.structuredContent as any;
  expect(sc.deprecated).toBe(true);
  expect(sc.redirected_to).toBe('create_or_update_entity');
  expect(sc.path).toBe('_entities/maria-x.md');
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/integration/entity-v1.test.ts test/unit/entity-resolver.test.ts
```

Expected: FAIL because tool and `_entities` resolver behavior are missing.

**Step 3: Implement**

Add `CreateOrUpdateEntitySchema` and `createOrUpdateEntity`.

Rules:

- Path: `_entities/${toKebabSlug(name)}.md`.
- Existing frontmatter is merged with new allowed fields.
- Reno may set `entity_type` only if missing.
- Reno may not set `verified_by`, `verified_at`, `source: human-curated`, `superseded_by`, or overwrite existing canonical identity fields.
- For Reno, bypass normal `_entities/** => renato` ownership only inside this tool after protected-field validation. Generic `write_note` must still fail via ownership.
- For Renato/admin, use normal ownership/admin semantics.

Update `upsertEntityProfile`:

- if legacy mode is `error`, return `DEPRECATED_TOOL`;
- otherwise map `entity_name -> name`, `entity_type -> entity_type`, `content`, `tags`, `status`, and call `createOrUpdateEntity`.

Update `EntityResolver` to prefer `_entities/**` for v1 entity lookups while preserving legacy lookup as fallback during migration.

Register `create_or_update_entity` in `src/server.ts`.

**Step 4: Run tests**

```bash
npm test -- test/integration/entity-v1.test.ts test/unit/entity-resolver.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/tools/workflows.ts src/server.ts src/vault/entity-resolver.ts test/unit/entity-resolver.test.ts test/integration/entity-v1.test.ts
git commit -m "feat(workflows): add controlled entity upserts"
```

---

### Task 8: `update_hub`, `upsert_runbook`, and `upsert_hub` Alias

**Files:**
- Modify: `src/tools/workflows.ts`
- Modify: `src/server.ts`
- Create: `test/integration/hub-runbook-v1.test.ts`

**Step 1: Write failing tests**

Create `test/integration/hub-runbook-v1.test.ts`:

```ts
it('update_hub writes Schema v1 hub under _hubs', async () => {
  const r = await updateHub({
    as_agent: 'renato',
    slug: 'clientes-ativos',
    title: 'Hub: Clientes ativos',
    summary: 'Mapa operacional.',
    related: ['[[_entities/bruno-savio]]'],
    tags: ['clientes'],
  }, ctx);
  expect((r.structuredContent as any).path).toBe('_hubs/clientes-ativos.md');
});

it('reno upsert_runbook is limited to reno prefix', async () => {
  const ok = await upsertRunbook({ as_agent: 'reno', slug: 'reno-registro-vault', title: 'Runbook: Reno registro vault', content: 'x' }, ctx);
  expect((ok.structuredContent as any).path).toBe('_runbooks/reno-registro-vault.md');
  const bad = await upsertRunbook({ as_agent: 'reno', slug: 'runbook-geral', title: 'Runbook: Geral', content: 'x' }, ctx);
  expect((bad.structuredContent as any).error.code).toBe('ROUTING_VIOLATION');
});

it('upsert_hub redirects to update_hub', async () => {
  const r = await upsertHub({ as_agent: 'renato', hub_type: 'fonte', slug: 'facebook-ads', display_name: 'Facebook Ads' }, ctx);
  expect((r.structuredContent as any).redirected_to).toBe('update_hub');
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/integration/hub-runbook-v1.test.ts
```

Expected: FAIL because tools are missing.

**Step 3: Implement**

Add `UpdateHubSchema`, `updateHub`, `UpsertRunbookSchema`, and `upsertRunbook`.

`updateHub` should be conservative:

- create if missing;
- merge frontmatter;
- append/update bounded sections like summary and related links;
- do not replace entire existing body unless explicit `replace_body: true` is added later.

`upsertRunbook` routing:

- Reno path must match `_runbooks/reno-*.md`.
- Renato/admin may use `_runbooks/runbook-*.md` or ownership-approved slug.

Alias `upsertHub` through `updateHub` when legacy mode is `redirect`, otherwise return `DEPRECATED_TOOL`.

Register `update_hub` and `upsert_runbook` in `src/server.ts`.

**Step 4: Run tests**

```bash
npm test -- test/integration/hub-runbook-v1.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/tools/workflows.ts src/server.ts test/integration/hub-runbook-v1.test.ts
git commit -m "feat(workflows): add v1 hubs and runbooks"
```

---

### Task 9: Validation and External ID Lookup Tools

**Files:**
- Modify: `src/tools/workflows.ts`
- Modify: `src/server.ts`
- Create: `test/integration/validation-v1.test.ts`

**Step 1: Write failing tests**

Create `test/integration/validation-v1.test.ts`:

```ts
it('validate_note returns structured errors and recommended tool', async () => {
  const r = await validateNote({
    path: '_agents/reno/old.md',
    content: 'no frontmatter',
  }, ctx);
  const sc = r.structuredContent as any;
  expect(sc.valid).toBe(false);
  expect(sc.errors.some((e: any) => e.category === 'legacy_namespace')).toBe(true);
  expect(sc.recommended_tool).toBe('create_journal_event');
});

it('validate_vault reports fixed categories', async () => {
  const r = await validateVault({}, ctx);
  const sc = r.structuredContent as any;
  expect(sc.categories).toEqual(expect.arrayContaining([
    'schema_error',
    'ownership_violation',
    'legacy_namespace',
    'broken_link',
    'trust_gap',
    'index_policy_gap',
    'routing_gap',
    'frontmatter_missing',
  ]));
});

it('find_entity_by_external_id searches _entities only', async () => {
  await createOrUpdateEntity({ as_agent: 'reno', name: 'Bruno Savio', entity_type: 'person', content: 'x', external_ids: { famachat_client_id: '123' } }, ctx);
  const r = await findEntityByExternalId({ key: 'famachat_client_id', value: '123' }, ctx);
  expect((r.structuredContent as any).matches[0].path).toBe('_entities/bruno-savio.md');
});
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/integration/validation-v1.test.ts
```

Expected: FAIL because tools are missing.

**Step 3: Implement**

Add schemas and handlers:

- `ValidateNoteSchema`, `validateNote`
- `ValidateVaultSchema`, `validateVault`
- `FindEntityByExternalIdSchema`, `findEntityByExternalId`

Validation categories must be stable strings:

```ts
const VALIDATION_CATEGORIES = [
  'schema_error',
  'ownership_violation',
  'legacy_namespace',
  'broken_link',
  'trust_gap',
  'index_policy_gap',
  'routing_gap',
  'frontmatter_missing',
] as const;
```

`validateVault` is read-only and should not attempt repair. It should aggregate counts and include affected paths.

Register all three tools in `src/server.ts`.

**Step 4: Run tests**

```bash
npm test -- test/integration/validation-v1.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/tools/workflows.ts src/server.ts test/integration/validation-v1.test.ts
git commit -m "feat(workflows): add schema v1 validation tools"
```

---

### Task 10: Legacy Mode Error Path and Registry Smoke

**Files:**
- Modify: `test/integration/workflows.test.ts`
- Modify: `test/e2e/smoke.test.ts`
- Modify: `README.md` only if tool count/docs are updated intentionally

**Step 1: Write failing tests**

Add tests that set `LEGACY_TOOL_MODE=error` through module reload or direct config isolation:

```ts
it('legacy alias in error mode fails without writing', async () => {
  process.env.LEGACY_TOOL_MODE = 'error';
  vi.resetModules();
  const mod = await import('../../src/tools/workflows.js?legacy-error');
  const r = await mod.createJournalEntry({ agent: 'reno', title: 'Nao escreve', content: 'x' }, ctx);
  expect((r.structuredContent as any).error.code).toBe('DEPRECATED_TOOL');
});
```

Update e2e smoke expected tool count and ensure these tools appear:

```ts
expect(names).toEqual(expect.arrayContaining([
  'create_journal_event',
  'record_decision',
  'create_or_update_entity',
  'upsert_runbook',
  'update_hub',
  'validate_note',
  'validate_vault',
  'find_entity_by_external_id',
]));
```

**Step 2: Run tests to verify failure**

```bash
npm test -- test/integration/workflows.test.ts
npm run build
npm run test:e2e
```

Expected: FAIL until registry/counts are updated.

**Step 3: Implement final registry/doc updates**

Ensure `src/server.ts` registry exposes all new tools with accurate descriptions and annotations:

- `create_journal_event`
- `record_decision`
- `create_or_update_entity`
- `upsert_runbook`
- `update_hub`
- `validate_note`
- `validate_vault`
- `find_entity_by_external_id`

If README tool count is maintained, update it in the same commit after verifying the final count with `tools/list`.

**Step 4: Run tests**

```bash
npm test -- test/integration/workflows.test.ts
npm run build
npm run test:e2e
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/server.ts test/integration/workflows.test.ts test/e2e/smoke.test.ts README.md
git commit -m "test: cover schema v1 tool registry"
```

---

### Task 11: Full Verification

**Files:**
- No code changes expected unless verification exposes bugs.

**Step 1: Run full checks**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all pass.

**Step 2: Inspect final diff**

```bash
git status --short
git log --oneline -8
```

Expected: only pre-existing unrelated changes remain unstaged, plus committed schema v1 implementation commits.

**Step 3: If failures occur**

Use `superpowers:systematic-debugging` before changing code. Add a failing regression test for the observed failure, fix minimally, rerun targeted tests, then full checks.

**Step 4: Completion commit**

If verification required no changes, no commit is needed. If fixes were needed:

```bash
git add <changed files>
git commit -m "fix: stabilize schema v1 implementation"
```

---

## Final Acceptance Checklist

- `write_note`, `append_to_note`, and `delete_note` reject `_agents/**` with `LEGACY_NAMESPACE_REMOVED`, even for `vault_admin`.
- `create_journal_entry`, `upsert_entity_profile`, and `upsert_hub` redirect only when `LEGACY_TOOL_MODE=redirect`.
- Legacy aliases fail without writing when `LEGACY_TOOL_MODE=error`.
- `append_decision` always returns `DEPRECATED_TOOL` and never writes.
- `create_journal_event` writes `_journal/<agent>/YYYY-MM-DD-{slug}.md` with Schema v1 frontmatter.
- `record_decision` writes atomic notes in `_decisions/`.
- `create_or_update_entity` lets Reno write controlled entity updates with provenance, but blocks protected fields.
- Trust-aware retrieval supports `min_trust=any|verified|human` and returns `trust_level` and `verified_mode`.
- `VaultIndex` exposes `index_policy`.
- `validate_note` and `validate_vault` report stable validation categories.
- `find_entity_by_external_id` searches `_entities/**`.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
