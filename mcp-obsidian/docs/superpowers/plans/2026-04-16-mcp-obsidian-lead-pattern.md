# mcp-obsidian Lead Pattern (Reno) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class support for `entity_type='lead'` to the mcp-obsidian MCP server — 3 dedicated tools (`upsert_lead_timeline`, `append_lead_interaction`, `read_lead_history`), lead-specific frontmatter schema, and a structured body convention (5 sections + append-only interaction log).

**Architecture:** A new `vault/lead.ts` parser/serializer handles the 5-section body layout and the timestamped interaction blocks below the `## Histórico de interações` delimiter. Tools use path `_agents/<as_agent>/lead/<slug>.md` and the ownership map already covers this via `_agents/<agent>/**`. Builds on Plan 1 foundation — no changes to HTTP/auth/index/git layers.

**Tech Stack:** TypeScript 5.7, vitest 2.1, zod 3, gray-matter, Node 20. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md` — focus on §5.1 sub-branch `entity_type='lead'`, §5.5 (Padrão lead — body convention), §4.2 lead tool rows, §6.2 errors (`LEAD_NOT_FOUND`, `MALFORMED_LEAD_BODY`), §9 criteria 10 + 11.

**Prerequisites:**
- Plan 1 merged and deployed (22 tools live at `mcp-obsidian.famachat.com.br`)
- `src/tools/_shared.ts`, `src/vault/fs.ts`, `src/vault/frontmatter.ts`, `src/vault/index.ts`, `src/last-write.ts`, `src/middleware/logger.ts` all exist
- Test fixture `test/fixtures/vault/_shared/context/AGENTS.md` includes `_agents/alfa/** => alfa` (already does)

**Out of scope (Plans 3-7):** broker tools, get_shared_context_delta, get_training_target_delta, financial-snapshot, broker exec view.

---

## File Structure

```
src/
├── vault/
│   └── lead.ts                    # NEW — parser/serializer of §5.5
├── tools/
│   └── workflows.ts               # MODIFY — add 3 lead tools
├── errors.ts                      # MODIFY — add LEAD_NOT_FOUND, MALFORMED_LEAD_BODY
├── server.ts                      # MODIFY — register 3 new tools
test/
├── unit/
│   └── lead.test.ts               # NEW — parser round-trip, malformed block detection
└── integration/
    └── lead-workflow.test.ts      # NEW — E2E: upsert → 3×append → read
```

**Responsibility cuts:**
- `vault/lead.ts`: pure markdown parsing/serialization for the 5-section body + interaction blocks. No ownership / no path logic — callers pass paths.
- `tools/workflows.ts`: append 3 tools that compose `vault/lead.ts` + `vault/fs.ts` + ownership + audit logging. Existing helpers (`today()`, `ownerCheck`, `validateOwners`) stay as-is.

---

## Phase A — Errors + schema

### Task A1: Add `LEAD_NOT_FOUND` + `MALFORMED_LEAD_BODY` to errors.ts

**Files:**
- Modify: `src/errors.ts`
- Modify: `test/unit/errors.test.ts`

- [ ] **Step 1: Update test to include new codes**

In `test/unit/errors.test.ts`, update the "ErrorCode enum includes all spec codes" test:

```ts
it('ErrorCode enum includes all spec codes', () => {
  const codes: ErrorCode[] = [
    'OWNERSHIP_VIOLATION', 'UNMAPPED_PATH', 'INVALID_FRONTMATTER',
    'INVALID_FILENAME', 'INVALID_OWNER', 'IMMUTABLE_TARGET',
    'JOURNAL_IMMUTABLE', 'NOTE_NOT_FOUND', 'WIKILINK_TARGET_MISSING',
    'GIT_LOCK_BUSY', 'GIT_PUSH_FAILED', 'VAULT_IO_ERROR',
    'LEAD_NOT_FOUND', 'MALFORMED_LEAD_BODY',
  ];
  expect(codes.length).toBe(14);
});
```

- [ ] **Step 2: Run test — expect FAIL** (unknown codes)

Run: `cd /root/mcp-fama/mcp-obsidian && API_KEY=t VAULT_PATH=/tmp npx vitest run test/unit/errors.test.ts`

- [ ] **Step 3: Add codes to the `ErrorCode` union in src/errors.ts**

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
  | 'VAULT_IO_ERROR'
  | 'LEAD_NOT_FOUND'
  | 'MALFORMED_LEAD_BODY';
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/errors.ts mcp-obsidian/test/unit/errors.test.ts
git -C /root/mcp-fama commit -m "feat(errors): add LEAD_NOT_FOUND + MALFORMED_LEAD_BODY error codes"
```

### Task A2: Extend entity-profile frontmatter schema for `entity_type='lead'`

**Files:**
- Modify: `src/vault/frontmatter.ts`
- Modify: `test/unit/frontmatter.test.ts`

**Spec §5.1 sub-branch:** `entity_type='lead'` accepts optional lead-commercial fields: `status_comercial?: string`, `origem?: string`, `interesse_atual?: string`, `objecoes_ativas?: string[]`, `proximo_passo?: string`.

- [ ] **Step 1: Add failing test**

Append to `test/unit/frontmatter.test.ts`:

```ts
describe('entity_type=lead sub-branch', () => {
  it('accepts lead-specific optional fields', () => {
    const src = `---
type: entity-profile
owner: reno
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: lead
entity_name: João Silva
status_comercial: qualificando
origem: campanha-union-vista
interesse_atual: 2-dormitorios
objecoes_ativas:
  - entrada alta
  - medo da parcela
proximo_passo: retomar com qualificação de renda
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).entity_type).toBe('lead');
    expect((r.frontmatter as any).status_comercial).toBe('qualificando');
    expect((r.frontmatter as any).objecoes_ativas).toEqual(['entrada alta', 'medo da parcela']);
    expect((r.frontmatter as any).proximo_passo).toContain('qualificação');
  });

  it('rejects objecoes_ativas when not an array of strings', () => {
    const src = `---
type: entity-profile
owner: reno
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: lead
entity_name: x
objecoes_ativas: "not an array"
---`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Update `EntityProfileSchema` in `src/vault/frontmatter.ts`**

Replace the existing `EntityProfileSchema` with a `z.discriminatedUnion`-style approach, OR add a `.superRefine` that validates lead-specific fields when `entity_type==='lead'`:

```ts
const EntityProfileSchema = BaseSchema.extend({
  type: z.literal('entity-profile'),
  entity_type: z.string().regex(kebabSegment),
  entity_name: z.string().min(1),
  status: z.string().optional(),
  // Lead-specific fields (optional; validated only when entity_type === 'lead')
  status_comercial: z.string().optional(),
  origem: z.string().optional(),
  interesse_atual: z.string().optional(),
  objecoes_ativas: z.array(z.string()).optional(),
  proximo_passo: z.string().optional(),
}).passthrough();
```

Zod's `.passthrough()` already preserves unknown fields. The lead-specific fields are always allowed on `entity-profile`; only the typecheck on `objecoes_ativas` (must be array of strings) is enforced. This matches the spec's §5.1 sub-branch semantics: lead-specific fields are "optional, validated when present".

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/frontmatter.ts mcp-obsidian/test/unit/frontmatter.test.ts
git -C /root/mcp-fama commit -m "feat(frontmatter): lead-specific fields on entity-profile (status_comercial, objecoes_ativas, etc)"
```

---

## Phase B — vault/lead.ts parser

### Task B1: Parse + serialize the 5-section body

**Files:**
- Create: `src/vault/lead.ts`
- Create: `test/unit/lead.test.ts`

**Spec §5.5 body structure:**

```markdown
## Resumo
<texto livre>

## Interesse atual
<texto livre>

## Objeções ativas
- <obj 1>
- <obj 2>

## Próximo passo
<texto livre>

## Histórico de interações

## YYYY-MM-DD HH:MM
Canal: <channel>
Origem: <origem>
Resumo: <summary>
Objeção: <objection>      # optional line
Próximo passo: <next_step> # optional line
Tags: #tag1 #tag2          # optional line
```

The `## Histórico de interações` header is the delimiter: everything above = 4 header sections (parsed by literal name); everything below = interaction blocks (parsed by timestamp regex).

- [ ] **Step 1: Write failing tests for `parseLeadBody`**

```ts
// test/unit/lead.test.ts
import { describe, it, expect } from 'vitest';
import { parseLeadBody, serializeLeadBody, parseInteractionBlocks, serializeInteractionBlock } from '../../src/vault/lead.js';
import type { LeadBody, LeadInteraction } from '../../src/vault/lead.js';

describe('parseLeadBody', () => {
  it('parses 4 header sections + interactions', () => {
    const body = `## Resumo
Lead interessado em 2Q.

## Interesse atual
Imóvel pronto.

## Objeções ativas
- entrada alta
- medo da parcela

## Próximo passo
Ligar na terça.

## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Origem: campanha-union-vista
Resumo: primeiro contato, entrou por tráfego pago

## 2026-04-11 14:15
Canal: telefone
Resumo: apresentou unidades disponíveis
Objeção: acha entrada alta
Próximo passo: enviar simulação CEF
`;
    const r = parseLeadBody(body);
    expect(r.headers.resumo).toContain('interessado em 2Q');
    expect(r.headers.interesse_atual).toContain('Imóvel pronto');
    expect(r.headers.objecoes_ativas).toEqual(['entrada alta', 'medo da parcela']);
    expect(r.headers.proximo_passo).toContain('terça');
    expect(r.interactions.length).toBe(2);
    expect(r.interactions[0].timestamp).toBe('2026-04-10 09:30');
    expect(r.interactions[0].channel).toBe('whatsapp');
    expect(r.interactions[0].origem).toBe('campanha-union-vista');
    expect(r.interactions[1].objection).toContain('entrada alta');
    expect(r.interactions[1].next_step).toContain('simulação');
    expect(r.malformed_blocks.length).toBe(0);
  });

  it('returns null for missing header sections (partial lead)', () => {
    const body = `## Resumo
Only resumo exists.

## Histórico de interações`;
    const r = parseLeadBody(body);
    expect(r.headers.resumo).toContain('Only');
    expect(r.headers.interesse_atual).toBeNull();
    expect(r.headers.objecoes_ativas).toBeNull();
    expect(r.headers.proximo_passo).toBeNull();
    expect(r.interactions).toEqual([]);
  });

  it('handles missing delimiter (no história section) — interactions empty', () => {
    const body = `## Resumo
x

## Interesse atual
y`;
    const r = parseLeadBody(body);
    expect(r.interactions).toEqual([]);
    expect(r.headers.resumo).toContain('x');
  });

  it('flags malformed blocks as warnings, returns valid ones', () => {
    const body = `## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Resumo: ok

## this is not a timestamp
garbage line

## 2026-04-11 10:00
Canal: email
Resumo: valid again`;
    const r = parseLeadBody(body);
    expect(r.interactions.length).toBe(2);
    expect(r.malformed_blocks.length).toBe(1);
    expect(r.malformed_blocks[0].line).toBeGreaterThan(0);
    expect(r.malformed_blocks[0].reason).toMatch(/timestamp/i);
  });
});

describe('serializeLeadBody round-trip', () => {
  it('round-trips a full lead body', () => {
    const input: LeadBody = {
      headers: {
        resumo: 'r',
        interesse_atual: 'i',
        objecoes_ativas: ['a', 'b'],
        proximo_passo: 'p',
      },
      interactions: [
        { timestamp: '2026-04-10 09:30', channel: 'whatsapp', origem: 'x', summary: 'hi', objection: null, next_step: null, tags: [] },
        { timestamp: '2026-04-11 14:15', channel: 'telefone', origem: null, summary: 's', objection: 'o', next_step: 'n', tags: ['#lead-quente'] },
      ],
      malformed_blocks: [],
    };
    const serialized = serializeLeadBody(input);
    const reparsed = parseLeadBody(serialized);
    expect(reparsed.headers.resumo).toBe('r');
    expect(reparsed.headers.objecoes_ativas).toEqual(['a', 'b']);
    expect(reparsed.interactions.length).toBe(2);
    expect(reparsed.interactions[0].channel).toBe('whatsapp');
    expect(reparsed.interactions[1].tags).toEqual(['#lead-quente']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

- [ ] **Step 3: Implement `src/vault/lead.ts`**

```ts
// src/vault/lead.ts

export interface LeadHeaders {
  resumo: string | null;
  interesse_atual: string | null;
  objecoes_ativas: string[] | null;
  proximo_passo: string | null;
}

export interface LeadInteraction {
  timestamp: string;       // YYYY-MM-DD HH:MM
  channel: string;
  origem: string | null;
  summary: string;
  objection: string | null;
  next_step: string | null;
  tags: string[];
}

export interface MalformedBlock {
  line: number;             // 1-indexed line of the `## ...` header
  reason: string;
}

export interface LeadBody {
  headers: LeadHeaders;
  interactions: LeadInteraction[];
  malformed_blocks: MalformedBlock[];
}

const HISTORY_DELIMITER = '## Histórico de interações';
const TIMESTAMP_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/;
const KV_RE = /^([A-Za-zÀ-ÿ ]+):\s*(.*)$/;

// Maps body `Chave:` (pt-BR) to interaction fields (en).
const FIELD_MAP: Record<string, keyof LeadInteraction> = {
  'canal': 'channel',
  'origem': 'origem',
  'resumo': 'summary',
  'objeção': 'objection',
  'próximo passo': 'next_step',
  'tags': 'tags',
};

export function parseLeadBody(body: string): LeadBody {
  const lines = body.split('\n');
  const delimIdx = lines.findIndex(l => l.trim() === HISTORY_DELIMITER);

  const headerLines = delimIdx >= 0 ? lines.slice(0, delimIdx) : lines;
  const historyLines = delimIdx >= 0 ? lines.slice(delimIdx + 1) : [];

  const headers = parseHeaderSections(headerLines);
  const { interactions, malformed_blocks } = parseInteractionBlocks(historyLines, delimIdx + 2);
  return { headers, interactions, malformed_blocks };
}

function parseHeaderSections(lines: string[]): LeadHeaders {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  const SECTION_RE = /^##\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      current = m[1].toLowerCase();
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
    resumo: getText('resumo'),
    interesse_atual: getText('interesse atual'),
    objecoes_ativas: getList('objeções ativas'),
    proximo_passo: getText('próximo passo'),
  };
}

export function parseInteractionBlocks(lines: string[], lineOffset = 1): { interactions: LeadInteraction[]; malformed_blocks: MalformedBlock[]; } {
  const interactions: LeadInteraction[] = [];
  const malformed_blocks: MalformedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    // Skip blank lines
    if (lines[i].trim() === '') { i++; continue; }
    if (lines[i].startsWith('## ')) {
      const headerLineNum = lineOffset + i;
      const m = lines[i].match(TIMESTAMP_RE);
      if (!m) {
        malformed_blocks.push({ line: headerLineNum, reason: `header '${lines[i].trim()}' does not match timestamp pattern YYYY-MM-DD HH:MM` });
        // Skip until next `## ` or EOF
        i++;
        while (i < lines.length && !lines[i].startsWith('## ')) i++;
        continue;
      }
      const timestamp = m[1];
      // Collect field lines until next `## ` or EOF
      const fieldLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('## ')) {
        fieldLines.push(lines[i]);
        i++;
      }
      try {
        const block = fieldsToInteraction(timestamp, fieldLines);
        interactions.push(block);
      } catch (e: any) {
        malformed_blocks.push({ line: headerLineNum, reason: e.message });
      }
      continue;
    }
    i++;
  }
  return { interactions, malformed_blocks };
}

function fieldsToInteraction(timestamp: string, fieldLines: string[]): LeadInteraction {
  const kv: Record<string, string> = {};
  for (const line of fieldLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const m = trimmed.match(KV_RE);
    if (!m) throw new Error(`malformed field line: '${trimmed}'`);
    const key = m[1].trim().toLowerCase();
    kv[key] = m[2].trim();
  }
  if (!kv['canal']) throw new Error(`missing required 'Canal:' field`);
  if (!kv['resumo']) throw new Error(`missing required 'Resumo:' field`);
  const tags: string[] = kv['tags']
    ? kv['tags'].split(/\s+/).filter(t => t.startsWith('#'))
    : [];
  return {
    timestamp,
    channel: kv['canal'],
    origem: kv['origem'] ?? null,
    summary: kv['resumo'],
    objection: kv['objeção'] ?? null,
    next_step: kv['próximo passo'] ?? null,
    tags,
  };
}

export function serializeInteractionBlock(i: LeadInteraction): string {
  const lines: string[] = [`## ${i.timestamp}`, `Canal: ${i.channel}`];
  if (i.origem) lines.push(`Origem: ${i.origem}`);
  lines.push(`Resumo: ${i.summary}`);
  if (i.objection) lines.push(`Objeção: ${i.objection}`);
  if (i.next_step) lines.push(`Próximo passo: ${i.next_step}`);
  if (i.tags && i.tags.length > 0) lines.push(`Tags: ${i.tags.join(' ')}`);
  return lines.join('\n');
}

export function serializeLeadBody(lead: LeadBody): string {
  const parts: string[] = [];
  if (lead.headers.resumo !== null) parts.push(`## Resumo\n${lead.headers.resumo}`);
  if (lead.headers.interesse_atual !== null) parts.push(`## Interesse atual\n${lead.headers.interesse_atual}`);
  if (lead.headers.objecoes_ativas !== null) parts.push(`## Objeções ativas\n${lead.headers.objecoes_ativas.map(o => `- ${o}`).join('\n')}`);
  if (lead.headers.proximo_passo !== null) parts.push(`## Próximo passo\n${lead.headers.proximo_passo}`);
  parts.push(`## Histórico de interações`);
  for (const i of lead.interactions) parts.push(serializeInteractionBlock(i));
  return parts.join('\n\n') + '\n';
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/lead.ts mcp-obsidian/test/unit/lead.test.ts
git -C /root/mcp-fama commit -m "feat(vault/lead): parser/serializer for §5.5 body (4 headers + timestamped interactions)"
```

---

## Phase C — Tools

### Task C1: `upsert_lead_timeline`

**Files:**
- Modify: `src/tools/workflows.ts` (append)
- Create: `test/integration/lead-workflow.test.ts`

- [ ] **Step 1: Test scaffolding**

```ts
// test/integration/lead-workflow.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { upsertLeadTimeline, appendLeadInteraction, readLeadHistory } from '../../src/tools/workflows.js';

const FIXTURE = path.resolve('test/fixtures/vault');
let ctx: { index: VaultIndex; vaultRoot: string };

beforeAll(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

const createdFiles: string[] = [];
afterEach(() => {
  for (const p of createdFiles.splice(0)) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const dir = path.dirname(p);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
});
```

- [ ] **Step 2: Failing tests for `upsert_lead_timeline`**

Append to `lead-workflow.test.ts`:

```ts
describe('upsert_lead_timeline', () => {
  it('creates _agents/<as_agent>/lead/<slug>.md with 5 sections', async () => {
    const r = await upsertLeadTimeline({
      as_agent: 'alfa',
      lead_name: 'João Silva',
      resumo: 'Interessado em 2 dormitórios',
      interesse_atual: 'Imóvel pronto até R$ 400k',
      objecoes_ativas: ['entrada alta', 'medo da parcela'],
      proximo_passo: 'Enviar simulação CEF',
      status_comercial: 'qualificando',
      origem: 'campanha-union-vista',
    }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_agents/alfa/lead/joao-silva.md');
    const full = path.join(FIXTURE, sc.path);
    createdFiles.push(full);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/type: entity-profile/);
    expect(content).toMatch(/entity_type: lead/);
    expect(content).toMatch(/status_comercial: qualificando/);
    expect(content).toMatch(/## Resumo/);
    expect(content).toMatch(/## Interesse atual/);
    expect(content).toMatch(/## Objeções ativas/);
    expect(content).toMatch(/## Próximo passo/);
    expect(content).toMatch(/## Histórico de interações/);
  });

  it('update preserves Histórico section and merges only passed fields', async () => {
    // Create
    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Maria Test',
      resumo: 'original resumo',
      proximo_passo: 'original proximo',
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/maria-test.md');
    createdFiles.push(full);

    // Simulate interaction existing in histórico
    const before = fs.readFileSync(full, 'utf8');
    const withHistory = before.replace(
      '## Histórico de interações',
      '## Histórico de interações\n\n## 2026-04-10 10:00\nCanal: whatsapp\nResumo: contato inicial'
    );
    fs.writeFileSync(full, withHistory);
    await ctx.index.updateAfterWrite('_agents/alfa/lead/maria-test.md');

    // Update only proximo_passo
    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Maria Test',
      proximo_passo: 'atualizado'
    }, ctx);
    const after = fs.readFileSync(full, 'utf8');
    expect(after).toMatch(/Resumo\s*\n\s*original resumo/);      // preserved
    expect(after).toMatch(/Próximo passo\s*\n\s*atualizado/);    // updated
    expect(after).toMatch(/## 2026-04-10 10:00/);                 // histórico preserved
    expect(after).toMatch(/contato inicial/);
  });

  it('OWNERSHIP_VIOLATION when as_agent is wrong owner', async () => {
    const r = await upsertLeadTimeline({ as_agent: 'beta', lead_name: 'Cross Agent' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('OWNERSHIP_VIOLATION');
  });

  it('INVALID_FILENAME when lead_name produces empty slug', async () => {
    const r = await upsertLeadTimeline({ as_agent: 'alfa', lead_name: '!!!' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_FILENAME');
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `upsertLeadTimeline` — append to `src/tools/workflows.ts`**

Add imports at top (keep existing):
```ts
import { parseLeadBody, serializeLeadBody, type LeadBody, type LeadHeaders } from '../vault/lead.js';
```

Add:

```ts
export const UpsertLeadTimelineSchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  resumo: z.string().optional(),
  interesse_atual: z.string().optional(),
  objecoes_ativas: z.array(z.string()).optional(),
  proximo_passo: z.string().optional(),
  status_comercial: z.string().optional(),
  origem: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
});

export async function upsertLeadTimeline(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertLeadTimelineSchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: LeadBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseLeadBody(parsed.body);
    }

    // Merge headers: new value overrides, absent keeps prior
    const mergedHeaders: LeadHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      interesse_atual: a.interesse_atual !== undefined ? a.interesse_atual : priorBody?.headers.interesse_atual ?? null,
      objecoes_ativas: a.objecoes_ativas !== undefined ? a.objecoes_ativas : priorBody?.headers.objecoes_ativas ?? null,
      proximo_passo: a.proximo_passo !== undefined ? a.proximo_passo : priorBody?.headers.proximo_passo ?? null,
    };

    const newBody: LeadBody = {
      headers: mergedHeaders,
      interactions: priorBody?.interactions ?? [],
      malformed_blocks: [],
    };

    const fm: Record<string, any> = {
      type: 'entity-profile',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags.length > 0 ? a.tags : (priorFm?.tags ?? []),
      entity_type: 'lead',
      entity_name: a.lead_name,
    };
    if (a.status_comercial !== undefined) fm.status_comercial = a.status_comercial;
    else if (priorFm?.status_comercial) fm.status_comercial = priorFm.status_comercial;
    if (a.origem !== undefined) fm.origem = a.origem;
    else if (priorFm?.origem) fm.origem = priorFm.origem;
    if (mergedHeaders.interesse_atual) fm.interesse_atual = mergedHeaders.interesse_atual;
    if (mergedHeaders.objecoes_ativas) fm.objecoes_ativas = mergedHeaders.objecoes_ativas;
    if (mergedHeaders.proximo_passo) fm.proximo_passo = mergedHeaders.proximo_passo;

    await writeFileAtomic(safe, serializeFrontmatter(fm, serializeLeadBody(newBody)));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_lead_timeline', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}
```

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/lead-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(tools/workflows): upsert_lead_timeline creates _agents/<agent>/lead/<slug>.md with 5 sections"
```

### Task C2: `append_lead_interaction`

- [ ] **Step 1: Failing tests**

Append to `lead-workflow.test.ts`:

```ts
describe('append_lead_interaction', () => {
  it('appends a block to Histórico de interações in chronological order', async () => {
    // Setup: create lead first
    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Carlos Lead',
      resumo: 'lead para teste de append'
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/carlos-lead.md');
    createdFiles.push(full);

    // Append two interactions
    const r1 = await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Carlos Lead',
      channel: 'whatsapp', summary: 'primeiro contato',
      origem: 'campanha', timestamp: '2026-04-10T09:30:00Z',
    }, ctx);
    expect(r1.isError).toBeUndefined();
    expect((r1.structuredContent as any).bytes_appended).toBeGreaterThan(0);

    const r2 = await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Carlos Lead',
      channel: 'telefone', summary: 'visita agendada',
      next_step: 'enviar endereço', tags: ['#lead-quente'],
      timestamp: '2026-04-11T14:15:00Z',
    }, ctx);
    expect(r2.isError).toBeUndefined();

    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/## 2026-04-10 09:30/);
    expect(content).toMatch(/## 2026-04-11 14:15/);
    expect(content).toMatch(/Canal: whatsapp/);
    expect(content).toMatch(/Canal: telefone/);
    expect(content).toMatch(/Tags: #lead-quente/);
    // Chronological order: 04-10 comes before 04-11
    const idx1 = content.indexOf('2026-04-10 09:30');
    const idx2 = content.indexOf('2026-04-11 14:15');
    expect(idx1).toBeLessThan(idx2);
  });

  it('LEAD_NOT_FOUND when lead doc does not exist', async () => {
    const r = await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Nonexistent',
      channel: 'x', summary: 'y',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEAD_NOT_FOUND');
  });

  it('uses now() when timestamp omitted, formatted as YYYY-MM-DD HH:MM', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Timestamp Test', resumo: 'x' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/timestamp-test.md');
    createdFiles.push(full);
    await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Timestamp Test',
      channel: 'email', summary: 'no ts passed',
    }, ctx);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `appendLeadInteraction`**

Append to `src/tools/workflows.ts`:

```ts
import { serializeInteractionBlock, type LeadInteraction } from '../vault/lead.js';
import { appendFileAtomic } from '../vault/fs.js';

export const AppendLeadInteractionSchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  channel: z.string().min(1),
  summary: z.string().min(1),
  origem: z.string().optional(),
  objection: z.string().optional(),
  next_step: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  timestamp: z.string().datetime().optional(),  // ISO-8601 datetime
});

function formatTimestamp(iso: string): string {
  // YYYY-MM-DD HH:MM (UTC, truncated to minutes)
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export async function appendLeadInteraction(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendLeadInteractionSchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) {
      throw new McpError('LEAD_NOT_FOUND', `Lead doc not found: ${rel}. Run upsert_lead_timeline first.`);
    }

    const ts = formatTimestamp(a.timestamp ?? new Date().toISOString());
    const interaction: LeadInteraction = {
      timestamp: ts,
      channel: a.channel,
      origem: a.origem ?? null,
      summary: a.summary,
      objection: a.objection ?? null,
      next_step: a.next_step ?? null,
      tags: a.tags,
    };

    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    const body = parsed.body;

    // Ensure delimiter present; if not, add it at end
    let newBodyText: string;
    if (body.includes('## Histórico de interações')) {
      newBodyText = body.trimEnd() + '\n\n' + serializeInteractionBlock(interaction) + '\n';
    } else {
      newBodyText = body.trimEnd() + '\n\n## Histórico de interações\n\n' + serializeInteractionBlock(interaction) + '\n';
    }

    const fm = { ...(parsed.frontmatter ?? {}), updated: today() };
    const fullNew = serializeFrontmatter(fm, newBodyText);
    const appendBytes = fullNew.length - raw.length;

    await writeFileAtomic(safe, fullNew);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_lead_interaction', as_agent: a.as_agent, path: rel, action: 'append', outcome: 'ok' });
    return { path: rel, bytes_appended: appendBytes, block_inserted_at: ts };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Appended interaction at ${(r.value as any).block_inserted_at} to ${(r.value as any).path}`);
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/lead-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(tools/workflows): append_lead_interaction appends timestamped block in chronological order"
```

### Task C3: `read_lead_history`

- [ ] **Step 1: Failing tests**

Append to `lead-workflow.test.ts`:

```ts
describe('read_lead_history', () => {
  it('returns lead header + interactions parsed structurally', async () => {
    await upsertLeadTimeline({
      as_agent: 'alfa', lead_name: 'Ana Read',
      resumo: 'r', interesse_atual: 'i', proximo_passo: 'p',
      objecoes_ativas: ['a', 'b'],
      status_comercial: 'negociando',
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/ana-read.md');
    createdFiles.push(full);

    await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Ana Read',
      channel: 'whatsapp', summary: 'primeiro',
      timestamp: '2026-04-10T09:30:00Z',
    }, ctx);
    await appendLeadInteraction({
      as_agent: 'alfa', lead_name: 'Ana Read',
      channel: 'telefone', summary: 'segundo',
      objection: 'entrada', next_step: 'enviar sim',
      timestamp: '2026-04-11T14:15:00Z',
    }, ctx);

    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Ana Read' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.lead.entity_name).toBe('Ana Read');
    expect(sc.lead.status_comercial).toBe('negociando');
    expect(sc.lead.objecoes_ativas).toEqual(['a', 'b']);
    expect(sc.interactions.length).toBe(2);
    // default order desc → newer first
    expect(sc.interactions[0].timestamp).toBe('2026-04-11 14:15');
    expect(sc.interactions[1].timestamp).toBe('2026-04-10 09:30');
    expect(sc.interactions[0].objection).toBe('entrada');
  });

  it('order=asc returns chronological order', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Bruno Asc', resumo: 'x' }, ctx);
    createdFiles.push(path.join(FIXTURE, '_agents/alfa/lead/bruno-asc.md'));
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Bruno Asc', channel: 'x', summary: 'a', timestamp: '2026-04-10T09:00:00Z' }, ctx);
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Bruno Asc', channel: 'x', summary: 'b', timestamp: '2026-04-11T09:00:00Z' }, ctx);
    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Bruno Asc', order: 'asc' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions[0].timestamp).toBe('2026-04-10 09:00');
    expect(sc.interactions[1].timestamp).toBe('2026-04-11 09:00');
  });

  it('since filters out older interactions', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Dani Since', resumo: 'x' }, ctx);
    createdFiles.push(path.join(FIXTURE, '_agents/alfa/lead/dani-since.md'));
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Dani Since', channel: 'x', summary: 'old', timestamp: '2026-04-01T00:00:00Z' }, ctx);
    await appendLeadInteraction({ as_agent: 'alfa', lead_name: 'Dani Since', channel: 'x', summary: 'recent', timestamp: '2026-04-15T00:00:00Z' }, ctx);
    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Dani Since', since: '2026-04-10T00:00:00Z' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.interactions[0].summary).toBe('recent');
  });

  it('MALFORMED_LEAD_BODY warning yields interactions minus the bad block', async () => {
    await upsertLeadTimeline({ as_agent: 'alfa', lead_name: 'Edu Bad', resumo: 'x' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/lead/edu-bad.md');
    createdFiles.push(full);
    // Manually corrupt the body
    const cur = fs.readFileSync(full, 'utf8');
    const corrupted = cur.replace(
      '## Histórico de interações\n',
      `## Histórico de interações\n\n## 2026-04-10 09:30\nCanal: ok\nResumo: good\n\n## not a timestamp\ngarbage\n`
    );
    fs.writeFileSync(full, corrupted);
    await ctx.index.updateAfterWrite('_agents/alfa/lead/edu-bad.md');

    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Edu Bad' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.warnings).toBeDefined();
    expect(sc.warnings[0].code).toBe('MALFORMED_LEAD_BODY');
  });

  it('LEAD_NOT_FOUND when lead missing', async () => {
    const r = await readLeadHistory({ as_agent: 'alfa', lead_name: 'Ghost' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('LEAD_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `readLeadHistory`**

Append to `src/tools/workflows.ts`:

```ts
export const ReadLeadHistorySchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export async function readLeadHistory(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadLeadHistorySchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('LEAD_NOT_FOUND', `Lead doc not found: ${rel}. Run upsert_lead_timeline first.`);

    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const lead = parseLeadBody(body);

    let interactions = lead.interactions;

    // since filter
    if (a.since) {
      const sinceTs = formatTimestamp(a.since);  // "YYYY-MM-DD HH:MM"
      interactions = interactions.filter(i => i.timestamp >= sinceTs);
    }
    // sort
    interactions = [...interactions].sort((x, y) => a.order === 'asc'
      ? x.timestamp.localeCompare(y.timestamp)
      : y.timestamp.localeCompare(x.timestamp));
    if (a.limit) interactions = interactions.slice(0, a.limit);

    const warnings = lead.malformed_blocks.map(m => ({ code: 'MALFORMED_LEAD_BODY', line: m.line, reason: m.reason }));

    return {
      lead: {
        entity_name: frontmatter?.entity_name ?? a.lead_name,
        status_comercial: frontmatter?.status_comercial ?? null,
        origem: frontmatter?.origem ?? null,
        resumo: lead.headers.resumo,
        interesse_atual: lead.headers.interesse_atual,
        objecoes_ativas: lead.headers.objecoes_ativas,
        proximo_passo: lead.headers.proximo_passo,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Lead '${(r.value as any).lead.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/lead-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(tools/workflows): read_lead_history with order/since filters + MALFORMED_LEAD_BODY warnings"
```

---

## Phase D — Server registration

### Task D1: Register 3 lead tools in server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add tool entries**

In `TOOL_REGISTRY`, add after `upsert_entity_profile`:

```ts
upsert_lead_timeline:   { schema: wf.UpsertLeadTimelineSchema,  handler: wf.upsertLeadTimeline,  desc: 'Upsert a lead timeline (5 sections)',        annotations: { idempotentHint: true, openWorldHint: false } },
append_lead_interaction:{ schema: wf.AppendLeadInteractionSchema,handler: wf.appendLeadInteraction,desc: 'Append an interaction block to a lead',    annotations: { openWorldHint: false } },
read_lead_history:      { schema: wf.ReadLeadHistorySchema,     handler: wf.readLeadHistory,     desc: 'Read lead header + interactions',            annotations: { readOnlyHint: true, openWorldHint: false } },
```

- [ ] **Step 2: Typecheck + test all**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck
API_KEY=t VAULT_PATH=/tmp npx vitest run
```

Expected: typecheck clean, all tests pass (previous 108 + ~14 new lead tests ≈ 122).

- [ ] **Step 3: Update e2e smoke test to assert 25 tools**

In `test/e2e/smoke.test.ts` update:
```ts
expect(r.result.tools.length).toBe(25);
```

- [ ] **Step 4: Run build + e2e**

```bash
npm run build
npx vitest run --config vitest.e2e.config.ts
```

- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/server.ts mcp-obsidian/test/e2e/smoke.test.ts
git -C /root/mcp-fama commit -m "feat(server): register 3 lead tools; total 25 tools + 2 resources"
```

---

## Phase E — Docs + deploy

### Task E1: Update README.md tool catalog

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update tool count**

Change `## Tools (22)` → `## Tools (25)` and under Workflows, add the 3 lead tools with brief signatures.

- [ ] **Step 2: Add new error codes to troubleshooting table**

Add rows for `LEAD_NOT_FOUND` and `MALFORMED_LEAD_BODY`.

- [ ] **Step 3: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/README.md
git -C /root/mcp-fama commit -m "docs(mcp-obsidian): README reflects 25 tools after Plan 2 (lead pattern)"
```

### Task E2: Rebuild + redeploy

- [ ] **Step 1: Build image**

```bash
cd /root/mcp-fama/mcp-obsidian && docker build -t mcp-obsidian:latest .
```

- [ ] **Step 2: Roll swarm service**

```bash
docker stack deploy -c docker-compose.yml mcp-obsidian
```

- [ ] **Step 3: Wait for roll + verify**

```bash
sleep 15 && docker service ps mcp-obsidian_mcp-obsidian --no-trunc | head -3
```

- [ ] **Step 4: Remote smoke — 25 tools**

```bash
API_KEY=$(cat /root/.mcp-obsidian-key 2>/dev/null || echo "SAVED_KEY_HERE")
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | sed 's/^data: //' | grep -oE '"name":"[^"]+"' | wc -l
```

Expected: `25`.

- [ ] **Step 5: Dogfood — real lead cycle**

Create a test lead and exercise the 3 tools against the live MCP. Use a dummy agent (`alfa` is only in fixture so may not resolve; use `reno` if production AGENTS.md maps it).

```bash
# upsert_lead_timeline
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"upsert_lead_timeline","arguments":{"as_agent":"reno","lead_name":"Smoke Test Lead","resumo":"teste de deploy Plan 2","status_comercial":"qualificando"}}}'

# append_lead_interaction
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp ... (similar)

# read_lead_history
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp ... (similar, expect 1 interaction)
```

Clean up the test lead after verification (use `delete_note`).

---

## Success criteria

1. 25 tools + 2 resources registered (`tools/list` returns 25).
2. All unit + integration tests pass (~122 expected).
3. e2e smoke test passes with 25-tool assertion.
4. Deploy rolls cleanly; remote smoke returns 25 tools.
5. Real lead cycle (upsert → 2× append → read) works end-to-end against the live MCP.
6. `MALFORMED_LEAD_BODY` warning does NOT fail the read; graceful degradation demonstrated in unit test.
7. Error codes `LEAD_NOT_FOUND` / `MALFORMED_LEAD_BODY` appear in README troubleshooting.

## Self-review notes

**Spec coverage:** §5.1 (lead sub-branch), §5.5 (5-section body), §4.2 3 tool rows, §6.2 2 error codes, §9 criteria 10 + 11. Everything accounted for.

**Type consistency:** `LeadHeaders`, `LeadInteraction`, `LeadBody`, `MalformedBlock` defined in `vault/lead.ts` and imported into `tools/workflows.ts`. `formatTimestamp` helper shared between `appendLeadInteraction` and `readLeadHistory` (extract if scope grows).

**Placeholder scan:** no TBD / TODO / vague steps.

**Deliberate limits:**
- `append_lead_interaction` sorts chronologically because we're inserting at end by default; `readLeadHistory` handles order at read time.
- `since` filter uses string comparison on `YYYY-MM-DD HH:MM` — works because format is lexicographically orderable.
- UTC timestamps (no timezone in spec body); consistent with how spec §5.5 shows `YYYY-MM-DD HH:MM`.

**Next plan:** Plan 3 (broker pattern + temporal filters + governance §1.1) for FamaAgent.
