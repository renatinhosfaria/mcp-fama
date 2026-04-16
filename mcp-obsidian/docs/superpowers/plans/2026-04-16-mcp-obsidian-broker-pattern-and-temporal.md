# mcp-obsidian Broker Pattern + Temporal Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class support for `entity_type='broker'` (FamaAgent) + cross-cutting `since`/`until` temporal filters on 4 existing search/list tools. Governance §1.1 exists in the spec already — the Plan 1 README already contains the summary; this plan adds a dedicated "Broker isolation" note per §5.7.

**Architecture:**
- `vault/broker.ts` parser/serializer mirrors `vault/lead.ts` mechanics but with broker-specific header sections and interaction fields.
- 3 new workflow tools follow the same shape as lead tools.
- `entity_type='broker'` sub-branch extends `EntityProfileSchema` with 8 broker-operational optional fields.
- Temporal filters add `since?`/`until?` to `search_content`, `search_by_tag`, `search_by_type`, `list_folder` — filter by `mtime` using the same source as `get_agent_delta`.
- §5.7 isolation: **design convention, not enforcement** — documented in README. Tools `*_broker_*` operate on one `broker_name` per call; there's no aggregate cross-broker tool in this plan.

**Tech Stack:** No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md` — §4.2 broker rows, §5.1 sub-branch `entity_type='broker'`, §5.6 (Padrão broker body convention), §5.7 (isolation convention), §6.2 errors (`BROKER_NOT_FOUND`, `MALFORMED_BROKER_BODY`, `INVALID_TIME_RANGE`). Also §1.1 governance (already summarized in README from Plan 1).

**Prerequisites:**
- Plans 1 + 2 merged and deployed (25 tools live)
- `src/vault/lead.ts` exists as the template to mirror
- `src/tools/workflows.ts` already imports lead types

**Out of scope (Plans 4-7):** `get_shared_context_delta`, `get_training_target_delta`, §5.8 canonical topic taxonomy, `regressoes/` topic, financial-snapshot, broker exec view (`get_broker_operational_summary`/`list_brokers_needing_attention`).

---

## File Structure

```
src/
├── vault/
│   └── broker.ts                  # NEW — parser/serializer §5.6
├── tools/
│   ├── workflows.ts               # MODIFY — add 3 broker tools
│   └── crud.ts                    # MODIFY — add since/until to list_folder, search_content
├── errors.ts                      # MODIFY — add BROKER_NOT_FOUND, MALFORMED_BROKER_BODY, INVALID_TIME_RANGE
├── vault/
│   └── frontmatter.ts             # MODIFY — broker sub-branch fields
├── server.ts                      # MODIFY — register 3 broker tools (28 total)
test/
├── unit/
│   └── broker.test.ts             # NEW
├── integration/
│   ├── broker-workflow.test.ts    # NEW
│   └── temporal-filters.test.ts   # NEW — covers since/until across all 4 tools
└── e2e/smoke.test.ts              # MODIFY — assert 28 tools
```

---

## Phase A — Errors + schema

### Task A1: Add 3 error codes

**Files:** `src/errors.ts`, `test/unit/errors.test.ts`

- [ ] **Step 1: Update existing test**

```ts
it('ErrorCode enum includes all spec codes', () => {
  const codes: ErrorCode[] = [
    'OWNERSHIP_VIOLATION', 'UNMAPPED_PATH', 'INVALID_FRONTMATTER',
    'INVALID_FILENAME', 'INVALID_OWNER', 'IMMUTABLE_TARGET',
    'JOURNAL_IMMUTABLE', 'NOTE_NOT_FOUND', 'WIKILINK_TARGET_MISSING',
    'GIT_LOCK_BUSY', 'GIT_PUSH_FAILED', 'VAULT_IO_ERROR',
    'LEAD_NOT_FOUND', 'MALFORMED_LEAD_BODY',
    'BROKER_NOT_FOUND', 'MALFORMED_BROKER_BODY', 'INVALID_TIME_RANGE',
  ];
  expect(codes.length).toBe(17);
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Add codes to `ErrorCode` union in `src/errors.ts`**

```ts
  | 'BROKER_NOT_FOUND'
  | 'MALFORMED_BROKER_BODY'
  | 'INVALID_TIME_RANGE';
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/errors.ts mcp-obsidian/test/unit/errors.test.ts
git -C /root/mcp-fama commit -m "feat(errors): add BROKER_NOT_FOUND, MALFORMED_BROKER_BODY, INVALID_TIME_RANGE"
```

### Task A2: Broker sub-branch in EntityProfileSchema

**Files:** `src/vault/frontmatter.ts`, `test/unit/frontmatter.test.ts`

Per §5.1 sub-branch `entity_type='broker'`, add these optional fields:
- `equipe?: string`
- `nivel_engajamento?: string`
- `comunicacao_estilo?: string`
- `contato_email?: string`
- `contato_whatsapp?: string`
- `dificuldades_recorrentes?: string[]`
- `padroes_atendimento?: string`
- `pendencias_abertas?: string[]`

- [ ] **Step 1: Add failing tests**

```ts
describe('entity_type=broker sub-branch', () => {
  it('accepts broker-specific optional fields', () => {
    const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: Maria Eduarda
equipe: centro
nivel_engajamento: ativo
comunicacao_estilo: direta e objetiva
contato_email: maria@fama.com
contato_whatsapp: "+5511999999999"
dificuldades_recorrentes:
  - objeção de entrada
  - medo de financiamento longo
padroes_atendimento: escuta ativa primeiro, depois apresentação
pendencias_abertas:
  - retornar sobre Union Vista
---
body`;
    const r = parseFrontmatter(src);
    expect((r.frontmatter as any).entity_type).toBe('broker');
    expect((r.frontmatter as any).equipe).toBe('centro');
    expect((r.frontmatter as any).dificuldades_recorrentes).toEqual(['objeção de entrada', 'medo de financiamento longo']);
    expect((r.frontmatter as any).pendencias_abertas).toHaveLength(1);
  });

  it('rejects dificuldades_recorrentes when not array of strings', () => {
    const src = `---
type: entity-profile
owner: famaagent
created: 2026-04-01
updated: 2026-04-16
tags: []
entity_type: broker
entity_name: x
dificuldades_recorrentes: not-an-array
---`;
    expect(() => parseFrontmatter(src)).toThrow(/INVALID_FRONTMATTER/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Extend `EntityProfileSchema`** in `src/vault/frontmatter.ts` — append the 8 optional fields:

```ts
const EntityProfileSchema = BaseSchema.extend({
  type: z.literal('entity-profile'),
  entity_type: z.string().regex(kebabSegment),
  entity_name: z.string().min(1),
  status: z.string().optional(),
  // Lead-specific (Plan 2)
  status_comercial: z.string().optional(),
  origem: z.string().optional(),
  interesse_atual: z.string().optional(),
  objecoes_ativas: z.array(z.string()).optional(),
  proximo_passo: z.string().optional(),
  // Broker-specific (Plan 3)
  equipe: z.string().optional(),
  nivel_engajamento: z.string().optional(),
  comunicacao_estilo: z.string().optional(),
  contato_email: z.string().optional(),
  contato_whatsapp: z.string().optional(),
  dificuldades_recorrentes: z.array(z.string()).optional(),
  padroes_atendimento: z.string().optional(),
  pendencias_abertas: z.array(z.string()).optional(),
}).passthrough();
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/frontmatter.ts mcp-obsidian/test/unit/frontmatter.test.ts
git -C /root/mcp-fama commit -m "feat(frontmatter): broker-specific fields on entity-profile (equipe, nivel_engajamento, pendencias_abertas, etc)"
```

---

## Phase B — vault/broker.ts parser

### Task B1: Parse + serialize broker body

**Files:** `src/vault/broker.ts`, `test/unit/broker.test.ts`

§5.6 body structure:

```markdown
## Resumo
<texto livre>

## Comunicação
<texto livre>

## Padrões de atendimento
<texto livre>

## Pendências abertas
- <pendência 1>
- <pendência 2>

## Histórico de interações

## YYYY-MM-DD HH:MM
Canal: <channel>
Lead em contexto: <lead_slug>      # optional
Resumo: <summary>
Dificuldade: <dificuldade>         # optional
Encaminhamento: <next_step>        # optional
Tags: #tag1 #tag2                  # optional
```

- [ ] **Step 1: Write tests**

```ts
// test/unit/broker.test.ts
import { describe, it, expect } from 'vitest';
import { parseBrokerBody, serializeBrokerBody, serializeInteractionBlock } from '../../src/vault/broker.js';
import type { BrokerBody, BrokerInteraction } from '../../src/vault/broker.js';

describe('parseBrokerBody', () => {
  it('parses 4 header sections + interactions', () => {
    const body = `## Resumo
Broker experiente, 3 anos de Fama.

## Comunicação
Prefere WhatsApp. Responde rápido de manhã.

## Padrões de atendimento
Sempre abre com pergunta aberta. Fecha com CTA objetivo.

## Pendências abertas
- retornar sobre Union Vista
- enviar simulação pro lead João

## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Lead em contexto: joao-silva
Resumo: apoio na objeção de entrada

## 2026-04-11 14:15
Canal: telefone
Resumo: 1:1 semanal
Dificuldade: está perdendo leads frios
Encaminhamento: testar retomada de 14 dias
`;
    const r = parseBrokerBody(body);
    expect(r.headers.resumo).toContain('experiente');
    expect(r.headers.comunicacao).toContain('WhatsApp');
    expect(r.headers.padroes_atendimento).toContain('pergunta aberta');
    expect(r.headers.pendencias_abertas).toEqual(['retornar sobre Union Vista', 'enviar simulação pro lead João']);
    expect(r.interactions.length).toBe(2);
    expect(r.interactions[0].timestamp).toBe('2026-04-10 09:30');
    expect(r.interactions[0].channel).toBe('whatsapp');
    expect(r.interactions[0].contexto_lead).toBe('joao-silva');
    expect(r.interactions[1].dificuldade).toContain('perdendo leads');
    expect(r.interactions[1].encaminhamento).toContain('retomada de 14 dias');
    expect(r.malformed_blocks.length).toBe(0);
  });

  it('handles missing sections gracefully (null)', () => {
    const body = `## Resumo
only resumo.

## Histórico de interações`;
    const r = parseBrokerBody(body);
    expect(r.headers.resumo).toContain('only');
    expect(r.headers.comunicacao).toBeNull();
    expect(r.headers.padroes_atendimento).toBeNull();
    expect(r.headers.pendencias_abertas).toBeNull();
    expect(r.interactions).toEqual([]);
  });

  it('flags malformed blocks in interactions', () => {
    const body = `## Histórico de interações

## 2026-04-10 09:30
Canal: whatsapp
Resumo: ok

## bad header
garbage

## 2026-04-11 10:00
Canal: email
Resumo: valid`;
    const r = parseBrokerBody(body);
    expect(r.interactions.length).toBe(2);
    expect(r.malformed_blocks.length).toBe(1);
  });
});

describe('serializeBrokerBody round-trip', () => {
  it('round-trips full body', () => {
    const input: BrokerBody = {
      headers: {
        resumo: 'r', comunicacao: 'c', padroes_atendimento: 'p',
        pendencias_abertas: ['a', 'b'],
      },
      interactions: [
        { timestamp: '2026-04-10 09:30', channel: 'whatsapp', contexto_lead: 'joao', summary: 's', dificuldade: null, encaminhamento: null, tags: [] },
        { timestamp: '2026-04-11 14:15', channel: 'telefone', contexto_lead: null, summary: 's2', dificuldade: 'd', encaminhamento: 'e', tags: ['#broker-ativo'] },
      ],
      malformed_blocks: [],
    };
    const out = serializeBrokerBody(input);
    const reparsed = parseBrokerBody(out);
    expect(reparsed.headers.pendencias_abertas).toEqual(['a', 'b']);
    expect(reparsed.interactions.length).toBe(2);
    expect(reparsed.interactions[0].contexto_lead).toBe('joao');
    expect(reparsed.interactions[1].tags).toEqual(['#broker-ativo']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `src/vault/broker.ts`** (mirror lead.ts pattern)

```ts
// src/vault/broker.ts
export interface BrokerHeaders {
  resumo: string | null;
  comunicacao: string | null;
  padroes_atendimento: string | null;
  pendencias_abertas: string[] | null;
}

export interface BrokerInteraction {
  timestamp: string;
  channel: string;
  contexto_lead: string | null;
  summary: string;
  dificuldade: string | null;
  encaminhamento: string | null;
  tags: string[];
}

export interface MalformedBlock { line: number; reason: string; }

export interface BrokerBody {
  headers: BrokerHeaders;
  interactions: BrokerInteraction[];
  malformed_blocks: MalformedBlock[];
}

const HISTORY_DELIMITER = '## Histórico de interações';
const TIMESTAMP_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/;
const KV_RE = /^([A-Za-zÀ-ÿ ]+):\s*(.*)$/;

export function parseBrokerBody(body: string): BrokerBody {
  const lines = body.split('\n');
  const delimIdx = lines.findIndex(l => l.trim() === HISTORY_DELIMITER);
  const headerLines = delimIdx >= 0 ? lines.slice(0, delimIdx) : lines;
  const historyLines = delimIdx >= 0 ? lines.slice(delimIdx + 1) : [];

  const headers = parseHeaderSections(headerLines);
  const { interactions, malformed_blocks } = parseInteractionBlocks(historyLines, delimIdx + 2);
  return { headers, interactions, malformed_blocks };
}

function parseHeaderSections(lines: string[]): BrokerHeaders {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  const SECTION_RE = /^##\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) { current = m[1].toLowerCase(); sections[current] = []; continue; }
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
    comunicacao: getText('comunicação') ?? getText('comunicacao'),
    padroes_atendimento: getText('padrões de atendimento') ?? getText('padroes de atendimento'),
    pendencias_abertas: getList('pendências abertas') ?? getList('pendencias abertas'),
  };
}

function parseInteractionBlocks(lines: string[], lineOffset = 1): { interactions: BrokerInteraction[]; malformed_blocks: MalformedBlock[]; } {
  const interactions: BrokerInteraction[] = [];
  const malformed_blocks: MalformedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    if (lines[i].startsWith('## ')) {
      const headerLineNum = lineOffset + i;
      const m = lines[i].match(TIMESTAMP_RE);
      if (!m) {
        malformed_blocks.push({ line: headerLineNum, reason: `header '${lines[i].trim()}' does not match timestamp pattern YYYY-MM-DD HH:MM` });
        i++;
        while (i < lines.length && !lines[i].startsWith('## ')) i++;
        continue;
      }
      const timestamp = m[1];
      const fieldLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('## ')) { fieldLines.push(lines[i]); i++; }
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

function fieldsToInteraction(timestamp: string, fieldLines: string[]): BrokerInteraction {
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
  const tags: string[] = kv['tags'] ? kv['tags'].split(/\s+/).filter(t => t.startsWith('#')) : [];
  return {
    timestamp,
    channel: kv['canal'],
    contexto_lead: kv['lead em contexto'] ?? null,
    summary: kv['resumo'],
    dificuldade: kv['dificuldade'] ?? null,
    encaminhamento: kv['encaminhamento'] ?? null,
    tags,
  };
}

export function serializeInteractionBlock(i: BrokerInteraction): string {
  const lines: string[] = [`## ${i.timestamp}`, `Canal: ${i.channel}`];
  if (i.contexto_lead) lines.push(`Lead em contexto: ${i.contexto_lead}`);
  lines.push(`Resumo: ${i.summary}`);
  if (i.dificuldade) lines.push(`Dificuldade: ${i.dificuldade}`);
  if (i.encaminhamento) lines.push(`Encaminhamento: ${i.encaminhamento}`);
  if (i.tags && i.tags.length > 0) lines.push(`Tags: ${i.tags.join(' ')}`);
  return lines.join('\n');
}

export function serializeBrokerBody(broker: BrokerBody): string {
  const parts: string[] = [];
  if (broker.headers.resumo !== null) parts.push(`## Resumo\n${broker.headers.resumo}`);
  if (broker.headers.comunicacao !== null) parts.push(`## Comunicação\n${broker.headers.comunicacao}`);
  if (broker.headers.padroes_atendimento !== null) parts.push(`## Padrões de atendimento\n${broker.headers.padroes_atendimento}`);
  if (broker.headers.pendencias_abertas !== null) parts.push(`## Pendências abertas\n${broker.headers.pendencias_abertas.map(o => `- ${o}`).join('\n')}`);
  parts.push(`## Histórico de interações`);
  for (const i of broker.interactions) parts.push(serializeInteractionBlock(i));
  return parts.join('\n\n') + '\n';
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/vault/broker.ts mcp-obsidian/test/unit/broker.test.ts
git -C /root/mcp-fama commit -m "feat(vault/broker): parser/serializer for §5.6 body (4 headers + timestamped interactions)"
```

---

## Phase C — Broker tools

### Task C1: upsert_broker_profile

**Files:** `src/tools/workflows.ts`, `test/integration/broker-workflow.test.ts`

- [ ] **Step 1: Test scaffolding**

```ts
// test/integration/broker-workflow.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { VaultIndex } from '../../src/vault/index.js';
import { upsertBrokerProfile, appendBrokerInteraction, readBrokerHistory } from '../../src/tools/workflows.js';

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

- [ ] **Step 2: Failing tests for `upsert_broker_profile`**

```ts
describe('upsert_broker_profile', () => {
  it('creates _agents/<as_agent>/broker/<slug>.md with 5 sections', async () => {
    const r = await upsertBrokerProfile({
      as_agent: 'alfa',
      broker_name: 'Maria Eduarda',
      resumo: 'Broker experiente, 3 anos',
      comunicacao: 'WhatsApp funcional',
      padroes_atendimento: 'Escuta ativa primeiro',
      pendencias_abertas: ['retornar Union Vista'],
      equipe: 'centro',
      nivel_engajamento: 'ativo',
    }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_agents/alfa/broker/maria-eduarda.md');
    const full = path.join(FIXTURE, sc.path);
    createdFiles.push(full);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/type: entity-profile/);
    expect(content).toMatch(/entity_type: broker/);
    expect(content).toMatch(/equipe: centro/);
    expect(content).toMatch(/## Resumo/);
    expect(content).toMatch(/## Comunicação/);
    expect(content).toMatch(/## Padrões de atendimento/);
    expect(content).toMatch(/## Pendências abertas/);
    expect(content).toMatch(/## Histórico de interações/);
  });

  it('update preserves Histórico and merges only passed fields', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Test Update', resumo: 'orig', comunicacao: 'orig c' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/test-update.md');
    createdFiles.push(full);
    // inject history
    const before = fs.readFileSync(full, 'utf8');
    const withHistory = before.replace(
      '## Histórico de interações',
      '## Histórico de interações\n\n## 2026-04-10 10:00\nCanal: whatsapp\nResumo: contato inicial'
    );
    fs.writeFileSync(full, withHistory);
    await ctx.index.updateAfterWrite('_agents/alfa/broker/test-update.md');
    // update only comunicacao
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Test Update', comunicacao: 'atualizado' }, ctx);
    const after = fs.readFileSync(full, 'utf8');
    expect(after).toMatch(/## Resumo\s*\n\s*orig/);
    expect(after).toMatch(/## Comunicação\s*\n\s*atualizado/);
    expect(after).toMatch(/## 2026-04-10 10:00/);
    expect(after).toMatch(/contato inicial/);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**
- [ ] **Step 4: Append to `src/tools/workflows.ts`**

Add imports:
```ts
import { parseBrokerBody, serializeBrokerBody, type BrokerBody, type BrokerHeaders, type BrokerInteraction, serializeInteractionBlock as serializeBrokerInteraction } from '../vault/broker.js';
```

Note: `serializeInteractionBlock` is already imported from lead.ts; rename the broker import to avoid collision.

Add tool:

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
  tags: z.array(z.string()).optional().default([]),
});

export async function upsertBrokerProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertBrokerProfileSchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: BrokerBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseBrokerBody(parsed.body);
    }

    const mergedHeaders: BrokerHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      comunicacao: a.comunicacao !== undefined ? a.comunicacao : priorBody?.headers.comunicacao ?? null,
      padroes_atendimento: a.padroes_atendimento !== undefined ? a.padroes_atendimento : priorBody?.headers.padroes_atendimento ?? null,
      pendencias_abertas: a.pendencias_abertas !== undefined ? a.pendencias_abertas : priorBody?.headers.pendencias_abertas ?? null,
    };

    const newBody: BrokerBody = {
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
      entity_type: 'broker',
      entity_name: a.broker_name,
    };
    // Broker-specific frontmatter: merge passed > prior
    for (const field of ['equipe','nivel_engajamento','comunicacao_estilo','contato_email','contato_whatsapp','padroes_atendimento'] as const) {
      const passed = (a as any)[field];
      if (passed !== undefined) fm[field] = passed;
      else if (priorFm?.[field] !== undefined) fm[field] = priorFm[field];
    }
    for (const listField of ['dificuldades_recorrentes','pendencias_abertas'] as const) {
      const passed = (a as any)[listField];
      if (passed !== undefined) fm[listField] = passed;
      else if (priorFm?.[listField] !== undefined) fm[listField] = priorFm[listField];
    }
    if (mergedHeaders.pendencias_abertas !== null) fm.pendencias_abertas = mergedHeaders.pendencias_abertas;

    await writeFileAtomic(safe, serializeFrontmatter(fm, serializeBrokerBody(newBody)));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_broker_profile', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}
```

- [ ] **Step 5: Run — PASS. Commit C1:**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/broker-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(tools/workflows): upsert_broker_profile creates _agents/<agent>/broker/<slug>.md with 5 sections"
```

### Task C2: append_broker_interaction

- [ ] **Step 1: Failing tests**

```ts
describe('append_broker_interaction', () => {
  it('appends a block to Histórico de interações', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Carlos Broker', resumo: 'test append' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/carlos-broker.md');
    createdFiles.push(full);

    const r = await appendBrokerInteraction({
      as_agent: 'alfa', broker_name: 'Carlos Broker',
      channel: 'whatsapp', summary: '1:1 semanal',
      contexto_lead: 'joao-silva', dificuldade: 'leads frios',
      encaminhamento: 'testar nova abordagem',
      tags: ['#broker-ativo'],
      timestamp: '2026-04-10T09:30:00Z',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).bytes_appended).toBeGreaterThan(0);
    const content = fs.readFileSync(full, 'utf8');
    expect(content).toMatch(/## 2026-04-10 09:30/);
    expect(content).toMatch(/Canal: whatsapp/);
    expect(content).toMatch(/Lead em contexto: joao-silva/);
    expect(content).toMatch(/Dificuldade: leads frios/);
    expect(content).toMatch(/Encaminhamento: testar nova/);
    expect(content).toMatch(/Tags: #broker-ativo/);
  });

  it('BROKER_NOT_FOUND when broker doc does not exist', async () => {
    const r = await appendBrokerInteraction({
      as_agent: 'alfa', broker_name: 'Ghost', channel: 'x', summary: 'y',
    }, ctx);
    expect((r.structuredContent as any).error.code).toBe('BROKER_NOT_FOUND');
  });

  it('contexto_lead is optional', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'No Context', resumo: 'x' }, ctx);
    createdFiles.push(path.join(FIXTURE, '_agents/alfa/broker/no-context.md'));
    const r = await appendBrokerInteraction({
      as_agent: 'alfa', broker_name: 'No Context',
      channel: 'telefone', summary: 'sem lead em contexto',
    }, ctx);
    expect(r.isError).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```ts
export const AppendBrokerInteractionSchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  channel: z.string().min(1),
  summary: z.string().min(1),
  contexto_lead: z.string().optional(),
  dificuldade: z.string().optional(),
  encaminhamento: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  timestamp: z.string().datetime().optional(),
});

export async function appendBrokerInteraction(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendBrokerInteractionSchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}. Run upsert_broker_profile first.`);

    const ts = formatTimestamp(a.timestamp ?? new Date().toISOString());
    const interaction: BrokerInteraction = {
      timestamp: ts,
      channel: a.channel,
      contexto_lead: a.contexto_lead ?? null,
      summary: a.summary,
      dificuldade: a.dificuldade ?? null,
      encaminhamento: a.encaminhamento ?? null,
      tags: a.tags,
    };

    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    const body = parsed.body;

    let newBodyText: string;
    if (body.includes('## Histórico de interações')) {
      newBodyText = body.trimEnd() + '\n\n' + serializeBrokerInteraction(interaction) + '\n';
    } else {
      newBodyText = body.trimEnd() + '\n\n## Histórico de interações\n\n' + serializeBrokerInteraction(interaction) + '\n';
    }

    const fm = { ...(parsed.frontmatter ?? {}), updated: today() };
    const fullNew = serializeFrontmatter(fm, newBodyText);
    const appendBytes = fullNew.length - raw.length;

    await writeFileAtomic(safe, fullNew);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_broker_interaction', as_agent: a.as_agent, path: rel, action: 'append', outcome: 'ok' });
    return { path: rel, bytes_appended: appendBytes, block_inserted_at: ts };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Appended broker interaction at ${(r.value as any).block_inserted_at}`);
}
```

- [ ] **Step 4: Run — PASS. Commit C2.**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/broker-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(tools/workflows): append_broker_interaction with contexto_lead anchor"
```

### Task C3: read_broker_history

- [ ] **Step 1: Failing tests**

```ts
describe('read_broker_history', () => {
  it('returns broker header + interactions (desc order default)', async () => {
    await upsertBrokerProfile({
      as_agent: 'alfa', broker_name: 'Ana Read Broker',
      resumo: 'r', comunicacao: 'c', padroes_atendimento: 'p',
      pendencias_abertas: ['a', 'b'],
      equipe: 'centro', nivel_engajamento: 'ativo',
    }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/ana-read-broker.md');
    createdFiles.push(full);

    await appendBrokerInteraction({ as_agent: 'alfa', broker_name: 'Ana Read Broker', channel: 'whatsapp', summary: 'first', timestamp: '2026-04-10T09:30:00Z' }, ctx);
    await appendBrokerInteraction({ as_agent: 'alfa', broker_name: 'Ana Read Broker', channel: 'telefone', summary: 'second', contexto_lead: 'joao', timestamp: '2026-04-11T14:15:00Z' }, ctx);

    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Ana Read Broker' }, ctx);
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.broker.entity_name).toBe('Ana Read Broker');
    expect(sc.broker.equipe).toBe('centro');
    expect(sc.broker.pendencias_abertas).toEqual(['a', 'b']);
    expect(sc.interactions.length).toBe(2);
    expect(sc.interactions[0].timestamp).toBe('2026-04-11 14:15');  // desc
    expect(sc.interactions[0].contexto_lead).toBe('joao');
    expect(sc.interactions[1].timestamp).toBe('2026-04-10 09:30');
  });

  it('BROKER_NOT_FOUND when missing', async () => {
    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Ghost B' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('BROKER_NOT_FOUND');
  });

  it('MALFORMED_BROKER_BODY warnings degrade gracefully', async () => {
    await upsertBrokerProfile({ as_agent: 'alfa', broker_name: 'Bad Broker', resumo: 'x' }, ctx);
    const full = path.join(FIXTURE, '_agents/alfa/broker/bad-broker.md');
    createdFiles.push(full);
    const cur = fs.readFileSync(full, 'utf8');
    const corrupted = cur.replace(
      '## Histórico de interações\n',
      `## Histórico de interações\n\n## 2026-04-10 09:30\nCanal: ok\nResumo: good\n\n## garbage\nbroken\n`
    );
    fs.writeFileSync(full, corrupted);
    await ctx.index.updateAfterWrite('_agents/alfa/broker/bad-broker.md');
    const r = await readBrokerHistory({ as_agent: 'alfa', broker_name: 'Bad Broker' }, ctx);
    const sc = r.structuredContent as any;
    expect(sc.interactions.length).toBe(1);
    expect(sc.warnings[0].code).toBe('MALFORMED_BROKER_BODY');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```ts
export const ReadBrokerHistorySchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export async function readBrokerHistory(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadBrokerHistorySchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}.`);

    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const broker = parseBrokerBody(body);

    let interactions = broker.interactions;
    if (a.since) {
      const sinceTs = formatTimestamp(a.since);
      interactions = interactions.filter(i => i.timestamp >= sinceTs);
    }
    interactions = [...interactions].sort((x, y) => a.order === 'asc'
      ? x.timestamp.localeCompare(y.timestamp)
      : y.timestamp.localeCompare(x.timestamp));
    if (a.limit) interactions = interactions.slice(0, a.limit);

    const warnings = broker.malformed_blocks.map(m => ({ code: 'MALFORMED_BROKER_BODY', line: m.line, reason: m.reason }));

    return {
      broker: {
        entity_name: frontmatter?.entity_name ?? a.broker_name,
        equipe: frontmatter?.equipe ?? null,
        nivel_engajamento: frontmatter?.nivel_engajamento ?? null,
        comunicacao_estilo: frontmatter?.comunicacao_estilo ?? null,
        contato_email: frontmatter?.contato_email ?? null,
        contato_whatsapp: frontmatter?.contato_whatsapp ?? null,
        dificuldades_recorrentes: frontmatter?.dificuldades_recorrentes ?? null,
        pendencias_abertas: broker.headers.pendencias_abertas ?? frontmatter?.pendencias_abertas ?? null,
        resumo: broker.headers.resumo,
        comunicacao: broker.headers.comunicacao,
        padroes_atendimento: broker.headers.padroes_atendimento,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Broker '${(r.value as any).broker.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}
```

- [ ] **Step 4: Run — PASS. Commit C3.**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/broker-workflow.test.ts
git -C /root/mcp-fama commit -m "feat(tools/workflows): read_broker_history with order/since + MALFORMED_BROKER_BODY warnings"
```

---

## Phase D — Temporal filters (cross-cutting)

Add `since?`/`until?` params to 4 existing tools: `list_folder`, `search_content`, `search_by_tag`, `search_by_type`.

### Task D1: Shared validator helper

**Files:** `src/tools/_shared.ts`

Add helper that parses + validates a `{since?, until?}` window:

- [ ] **Step 1: Append to `src/tools/_shared.ts`**

```ts
export interface TimeWindow { sinceMs: number | null; untilMs: number | null; }

export function validateTimeRange(since?: string, until?: string): TimeWindow {
  let sinceMs: number | null = null;
  let untilMs: number | null = null;
  if (since !== undefined) {
    const t = Date.parse(since);
    if (isNaN(t)) throw new McpError('INVALID_TIME_RANGE', `'since' is not valid ISO-8601: '${since}'`);
    sinceMs = t;
  }
  if (until !== undefined) {
    const t = Date.parse(until);
    if (isNaN(t)) throw new McpError('INVALID_TIME_RANGE', `'until' is not valid ISO-8601: '${until}'`);
    untilMs = t;
  }
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    throw new McpError('INVALID_TIME_RANGE', `'since' must be ≤ 'until' (since=${since}, until=${until})`);
  }
  return { sinceMs, untilMs };
}

export function mtimeInWindow(mtimeMs: number, window: TimeWindow): boolean {
  if (window.sinceMs !== null && mtimeMs < window.sinceMs) return false;
  if (window.untilMs !== null && mtimeMs > window.untilMs) return false;
  return true;
}
```

No separate test for this — it's exercised via D2 integration tests.

### Task D2: Integration test covering all 4 tools with temporal filters

**Files:** `test/integration/temporal-filters.test.ts`

- [ ] **Step 1: Write test that exercises all 4 tools**

```ts
// test/integration/temporal-filters.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { listFolder, searchContent } from '../../src/tools/crud.js';
import { searchByTag, searchByType } from '../../src/tools/workflows.js';

describe('temporal filters across tools', () => {
  let tmp: string; let ctx: any;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-temp-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\n```');
    fs.mkdirSync(path.join(tmp, '_agents/alfa'), { recursive: true });
    // Old note (forced mtime 2026-01-01)
    const oldPath = path.join(tmp, '_agents/alfa/old.md');
    fs.writeFileSync(oldPath, `---
type: journal
owner: alfa
created: 2026-01-01
updated: 2026-01-01
tags: [foo]
---
old content with keyword banana`);
    fs.utimesSync(oldPath, new Date('2026-01-01'), new Date('2026-01-01'));
    // New note (now)
    const newPath = path.join(tmp, '_agents/alfa/new.md');
    fs.writeFileSync(newPath, `---
type: journal
owner: alfa
created: 2026-04-16
updated: 2026-04-16
tags: [foo]
---
new content with keyword banana`);

    const index = new VaultIndex(tmp); await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('list_folder with since filters old entries', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, since: '2026-03-01T00:00:00Z' }, ctx);
    const items = (r.structuredContent as any).items;
    expect(items.map((i: any) => i.path)).toContain('_agents/alfa/new.md');
    expect(items.map((i: any) => i.path)).not.toContain('_agents/alfa/old.md');
  });

  it('list_folder with until filters new entries', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, until: '2026-02-01T00:00:00Z' }, ctx);
    const items = (r.structuredContent as any).items;
    expect(items.map((i: any) => i.path)).toContain('_agents/alfa/old.md');
    expect(items.map((i: any) => i.path)).not.toContain('_agents/alfa/new.md');
  });

  it('list_folder rejects since > until', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, since: '2026-06-01T00:00:00Z', until: '2026-01-01T00:00:00Z' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_TIME_RANGE');
  });

  it('list_folder rejects malformed since', async () => {
    const r = await listFolder({ path: '_agents/alfa', recursive: true, since: 'not-a-date' }, ctx);
    expect((r.structuredContent as any).error.code).toBe('INVALID_TIME_RANGE');
  });

  it('search_by_tag filters by since', async () => {
    const r = await searchByTag({ tag: 'foo', since: '2026-03-01T00:00:00Z' }, ctx);
    const notes = (r.structuredContent as any).notes;
    expect(notes.map((n: any) => n.path)).toContain('_agents/alfa/new.md');
    expect(notes.map((n: any) => n.path)).not.toContain('_agents/alfa/old.md');
  });

  it('search_by_type filters by until', async () => {
    const r = await searchByType({ type: 'journal', until: '2026-02-01T00:00:00Z' }, ctx);
    const notes = (r.structuredContent as any).notes;
    expect(notes.map((n: any) => n.path)).toContain('_agents/alfa/old.md');
    expect(notes.map((n: any) => n.path)).not.toContain('_agents/alfa/new.md');
  });

  it('search_content filters by since (post-ripgrep filter via mtime)', async () => {
    const r = await searchContent({ query: 'banana', since: '2026-03-01T00:00:00Z' }, ctx);
    const matches = (r.structuredContent as any).matches;
    expect(matches.map((m: any) => m.path)).toContain('_agents/alfa/new.md');
    expect(matches.map((m: any) => m.path)).not.toContain('_agents/alfa/old.md');
  });
});
```

Note: `search_content` may be skipped if `rg` not installed locally — use `describe.skipIf(!rgAvailable)` wrapper if needed; otherwise keep plain.

- [ ] **Step 2: Run — expect FAIL** (params not yet accepted)

### Task D3: Add `since`/`until` to the 4 tools

#### list_folder (src/tools/crud.ts)

- [ ] **Step 1: Extend `ListFolderSchema`**

```ts
export const ListFolderSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional().default(false),
  filter_type: z.string().optional(),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
});
```

- [ ] **Step 2: Apply window filter after existing filters**

In `listFolder`, after the owner filter and before sorting, add:

```ts
const window = validateTimeRange(a.since, a.until);  // throws INVALID_TIME_RANGE
if (window.sinceMs !== null || window.untilMs !== null) {
  entries = entries.filter(e => mtimeInWindow(e.mtimeMs, window));
}
```

Ensure `mtimeMs` is available in the sorted IndexEntry (it already is from Plan 1 F1/F2).

Import the helpers:
```ts
import { ToolCtx, tryToolBody, ok, ownerCheck, isDecisionsPath, validateOwners, encodeCursor, decodeCursor, hashQuery, validateTimeRange, mtimeInWindow } from './_shared.js';
```

#### search_content

- [ ] **Step 1: Extend `SearchContentSchema`** — same pattern (add `since`, `until`)
- [ ] **Step 2: Apply window filter** — after owner filter:

```ts
const window = validateTimeRange(a.since, a.until);
if (window.sinceMs !== null || window.untilMs !== null) {
  matches = matches.filter(m => {
    const e = ctx.index.get(m.path);
    return e ? mtimeInWindow(e.mtimeMs, window) : false;
  });
}
```

#### search_by_tag (src/tools/workflows.ts)

Similar pattern — add `since`/`until` to schema, apply window filter on the index entries.

#### search_by_type

Same as search_by_tag.

- [ ] **Step 3: Run all tests — PASS** (including temporal-filters.test.ts)

- [ ] **Step 4: Commit D3**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/tools/_shared.ts mcp-obsidian/src/tools/crud.ts mcp-obsidian/src/tools/workflows.ts mcp-obsidian/test/integration/temporal-filters.test.ts
git -C /root/mcp-fama commit -m "feat(tools): since/until temporal filters on list_folder, search_content, search_by_tag, search_by_type"
```

---

## Phase E — Server registration + README

### Task E1: Register 3 broker tools in server.ts

- [ ] **Step 1: Add to `TOOL_REGISTRY`** (after `read_lead_history`):

```ts
  upsert_broker_profile:    { schema: wf.UpsertBrokerProfileSchema,    handler: wf.upsertBrokerProfile,    desc: 'Upsert a broker profile (5 sections)', annotations: { idempotentHint: true, openWorldHint: false } },
  append_broker_interaction:{ schema: wf.AppendBrokerInteractionSchema,handler: wf.appendBrokerInteraction,desc: 'Append a broker interaction block',     annotations: { openWorldHint: false } },
  read_broker_history:      { schema: wf.ReadBrokerHistorySchema,      handler: wf.readBrokerHistory,      desc: 'Read broker profile + interactions',   annotations: { readOnlyHint: true, openWorldHint: false } },
```

- [ ] **Step 2: Update `test/e2e/smoke.test.ts`** — change `toBe(25)` to `toBe(28)`.
- [ ] **Step 3: Typecheck + test + build + e2e**

```bash
cd /root/mcp-fama/mcp-obsidian
npm run typecheck && API_KEY=t VAULT_PATH=/tmp npx vitest run && npm run build && npx vitest run --config vitest.e2e.config.ts
```

- [ ] **Step 4: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/src/server.ts mcp-obsidian/test/e2e/smoke.test.ts
git -C /root/mcp-fama commit -m "feat(server): register 3 broker tools; total 28 tools + 2 resources"
```

### Task E2: Update README

- [ ] **Step 1: Update tool count** (22 → 25 was Plan 2; now 25 → 28)
- [ ] **Step 2: Add broker section** under Workflows:

```markdown
### Workflows — Broker pattern (3) — Plan 3

First-class support for `entity_type=broker` per spec §5.6. Docs follow 5-section convention: Resumo / Comunicação / Padrões de atendimento / Pendências abertas / Histórico de interações. Broker-specific frontmatter: `equipe`, `nivel_engajamento`, `comunicacao_estilo`, `contato_email`, `contato_whatsapp`, `dificuldades_recorrentes`, `padroes_atendimento`, `pendencias_abertas`.

| Tool | Signature | Writes to |
|---|---|---|
| `upsert_broker_profile` | `(as_agent, broker_name, resumo?, comunicacao?, padroes_atendimento?, pendencias_abertas?, equipe?, nivel_engajamento?, comunicacao_estilo?, contato_email?, contato_whatsapp?, dificuldades_recorrentes?, tags?)` | `_agents/<as_agent>/broker/<slug>.md` — merges with prior, preserves Histórico |
| `append_broker_interaction` | `(as_agent, broker_name, channel, summary, contexto_lead?, dificuldade?, encaminhamento?, tags?, timestamp?)` | appends `## YYYY-MM-DD HH:MM` block; `contexto_lead` anchors to a lead slug without aglutinating contexts |
| `read_broker_history` | `(as_agent, broker_name, since?, limit?, order?='desc')` | (read) broker headers + interactions; warnings on malformed blocks |
```

- [ ] **Step 3: Add broker isolation note** (§5.7) — new subsection after Tools:

```markdown
## Broker isolation (§5.7)

`*_broker_*` tools operate on **one `broker_name` per call** — no cross-broker aggregation. This is a design convention, not a technical enforcement. Agents that attend multiple brokers (e.g. FamaAgent) must keep broker contexts separate in their own reasoning; the MCP helps by refusing to bundle them.

No `list_brokers_needing_attention` or `get_broker_operational_summary` in this plan — those come in Plan 7.
```

- [ ] **Step 4: Update troubleshooting table** with 3 new codes:

```markdown
| `BROKER_NOT_FOUND` | broker doc does not exist | run `upsert_broker_profile` first |
| `MALFORMED_BROKER_BODY` (warn) | interaction block malformed | `read_broker_history` skips + reports in warnings |
| `INVALID_TIME_RANGE` | `since`/`until` malformed ISO-8601 or since > until | check datetime format |
```

- [ ] **Step 5: Add temporal filters note** to the Tools intro:

```markdown
`list_folder`, `search_content`, `search_by_tag`, `search_by_type` accept optional `since?` and `until?` (ISO-8601 datetime) to filter by `mtime`. Ranges are validated: malformed dates or `since > until` return `INVALID_TIME_RANGE`.
```

- [ ] **Step 6: Commit**

```bash
git -C /root/mcp-fama add mcp-obsidian/README.md
git -C /root/mcp-fama commit -m "docs(mcp-obsidian): README reflects 28 tools + broker pattern + temporal filters + §5.7 isolation"
```

---

## Phase F — Deploy

### Task F1: Build + roll production

- [ ] **Step 1: Build image**

```bash
cd /root/mcp-fama/mcp-obsidian && docker build -t mcp-obsidian:latest .
```

- [ ] **Step 2: Roll service**

```bash
docker service update --force mcp-obsidian_mcp-obsidian
```

- [ ] **Step 3: Wait + smoke — 28 tools**

```bash
sleep 10
KEY='8140541e0b9f1243c1b5f76060c374c9867b9f5dde3de376'
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | sed 's/^data: //' | grep -oE '"name":"[^"]+"' | wc -l
```

Expected: `28`.

- [ ] **Step 4: Dogfood — broker cycle**

```bash
# upsert_broker_profile
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"upsert_broker_profile","arguments":{"as_agent":"famaagent","broker_name":"Smoke Test Plan 3","resumo":"teste de deploy Plan 3","equipe":"smoke","nivel_engajamento":"ativo"}}}'

# append_broker_interaction
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"append_broker_interaction","arguments":{"as_agent":"famaagent","broker_name":"Smoke Test Plan 3","channel":"whatsapp","summary":"smoke test","dificuldade":"teste"}}}'

# read_broker_history
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_broker_history","arguments":{"as_agent":"famaagent","broker_name":"Smoke Test Plan 3"}}}'

# cleanup
curl -s -X POST https://mcp-obsidian.famachat.com.br/mcp \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"delete_note","arguments":{"path":"_agents/famaagent/broker/smoke-test-plan-3.md","as_agent":"famaagent","reason":"smoke cleanup"}}}'
```

---

## Success criteria

1. 28 tools + 2 resources registered (tools/list returns 28)
2. All unit + integration tests pass (expected ~150+ total)
3. E2E smoke passes with 28-tool assertion
4. Deploy rolls cleanly; remote smoke returns 28
5. Real broker cycle (upsert → append → read → delete) works against live MCP
6. Temporal filters work across all 4 search/list tools; `INVALID_TIME_RANGE` enforced
7. README reflects new tool count + broker section + §5.7 isolation + updated troubleshooting

## Self-review notes

- Broker parser mirrors lead parser — intentional duplication (spec §11 suggests consolidation as upgrade path when 3rd entity_type lands, not in this plan).
- `formatTimestamp` helper is already in workflows.ts from Plan 2 — reused for broker.
- `since`/`until` validation is centralized in `_shared.ts` (single source of truth for INVALID_TIME_RANGE).
- `contexto_lead` in broker interactions is a slug string — no enforcement that the lead exists. Spec §5.6 leaves it as informal anchor; upgrade path could add validation.

**Next plan:** Plan 4 (Follow-up heartbeat: `get_shared_context_delta` + §5.8 canonical topics taxonomy).
