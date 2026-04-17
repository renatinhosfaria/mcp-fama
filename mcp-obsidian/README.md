# mcp-obsidian

MCP server exposing the fama-brain Obsidian vault to LLM agents with ownership enforcement, append-only decision trail, and git-coordinated sync with the `brain-sync.sh` cron.

This repo implements **Plans 1-7** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`:
- **Plan 1** (Foundation + Core): HTTP transport, auth, vault layer (fs, frontmatter, ownership, index, git), 22 tools + 2 resources.
- **Plan 2** (Lead pattern for Reno): `entity_type=lead` first-class with 3 tools and §5.5 body convention.
- **Plan 3** (Broker pattern for FamaAgent + temporal filters): `entity_type=broker` first-class with 3 tools and §5.6 body convention. §5.7 broker isolation convention.
- **Plan 4** (Follow-up heartbeat): `get_shared_context_delta(since, topics?, owners?)` cross-agent read grouped by topic. §5.8 canonical 6-topic taxonomy.
- **Plan 5** (Sparring training-target): `get_training_target_delta(target_agent, since, topics?)` with `regressoes/` body-field projection.
- **Plan 6** (cfo-exec financial snapshots): `type: financial-snapshot` + `upsert_financial_snapshot` + `read_financial_series`. §5.9 body convention.
- **Plan 7** (ceo-exec broker executive views): broker `nivel_atencao?` + `ultima_acao_recomendada?`. `get_broker_operational_summary` (composed read + descriptive `sinais_de_risco`) + `list_brokers_needing_attention` (portfolio scan with fixed `priority_score` formula).

**Spec complete: 34 tools + 2 resources.**

## Quickstart

    cp .env.example .env   # then edit: set API_KEY, VAULT_PATH
    docker compose up --build
    curl -sH "Authorization: Bearer $API_KEY" -X POST localhost:3201/mcp \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

Expected output: `34`. Healthcheck: `curl localhost:3201/health` (no auth).

## Dev

    npm install
    API_KEY=t VAULT_PATH=/path/to/vault npm run dev      # tsx watch
    npm test                                              # vitest
    npm run typecheck
    npm run build                                         # emits dist/

## Ownership (AGENTS.md format)

`_shared/context/AGENTS.md` in the vault root must contain fenced code block(s) with lines matching `<glob-pattern> => <agent>`. First match wins.

Example block (inside triple-backticks in AGENTS.md):

    _agents/reno/**            => reno
    _shared/goals/*/reno.md    => reno
    _shared/context/*/reno/**  => reno
    README.md                  => renato

Patterns support minimatch globs including mid-path wildcards (`_shared/context/*/reno/**`).

## Temporal filters

`list_folder`, `search_content`, `search_by_tag`, `search_by_type` accept optional `since?` and `until?` (ISO-8601 datetime) to filter by `mtime`. Malformed dates or `since > until` return `INVALID_TIME_RANGE`.

## Tools (34)

### CRUD (8)

| Tool | Signature | Notes |
|---|---|---|
| `read_note` | `(path)` | frontmatter + body + wikilinks + backlinks_count + bytes + mtime |
| `write_note` | `(path, content, frontmatter, as_agent)` | creates/overwrites; blocks `decisions.md` |
| `append_to_note` | `(path, content, as_agent)` | appends; blocks `decisions.md` |
| `delete_note` | `(path, as_agent, reason)` | mandatory reason for audit log |
| `list_folder` | `(path, recursive?, filter_type?, owner?, since?, until?, cursor?, limit?)` | paginated; owner = string \| string[] |
| `search_content` | `(query, path?, type?, tag?, owner?, since?, until?, cursor?, limit?)` | ripgrep-powered |
| `get_note_metadata` | `(path)` | frontmatter + links + backlinks + bytes |
| `stat_vault` | `()` | total_notes, by_type, by_agent, index_age_ms |

### Workflows — generic (18)

| Tool | Signature | Writes to |
|---|---|---|
| `create_journal_entry` | `(agent, title, content, tags?)` | `_agents/<agent>/journal/YYYY-MM-DD-<slug>.md` |
| `append_decision` | `(agent, title, rationale, tags?)` | prepend in `_agents/<agent>/decisions.md` |
| `update_agent_profile` | `(agent, content)` | `_agents/<agent>/profile.md` body, preserves frontmatter |
| `upsert_goal` | `(agent, period, content)` | `_shared/goals/<period>/<agent>.md` (YYYY-MM) |
| `upsert_result` | `(agent, period, content)` | `_shared/results/<period>/<agent>.md` |
| `read_agent_context` | `(agent, n_decisions?, n_journals?)` | (read) profile + decisions + journals + goals + results |
| `get_agent_delta` | `(agent, since, types?, include_content?)` | (read) grouped delta since ISO datetime |
| `get_shared_context_delta` | `(since, topics?, owners?, include_content?)` | (read) shared-context written by any agent, grouped by topic — powers Follow-up heartbeat |
| `get_training_target_delta` | `(target_agent, since, topics?, include_content?)` | (read) target's agent_delta + shared-about-target (from other owners, by `#alvo-<target>` tag or body) + regressoes projection with status/severidade/categoria parsed |
| `upsert_financial_snapshot` | `(as_agent, period (YYYY-MM), caixa?, receita?, despesa?, alertas?, contexto?, caixa_resumo?, receita_resumo?, despesa_resumo?, tags?)` | `_shared/financials/<period>/<as_agent>.md` — merges with prior; auto-extracts `*_resumo` from first non-empty body line; auto-counts `alertas_count` |
| `read_financial_series` | `(as_agent, periods?, since?, until?, limit?=12, order?='desc')` | (read) parsed 5-section series. Explicit `periods[]` missing → `SNAPSHOT_NOT_FOUND`; `since`/`until` lexicographic YYYY-MM filter (silent omit) |
| `get_broker_operational_summary` | `(as_agent, broker_name, n_recent_interactions?=5, periodo_tendencia_dias?=28)` | (read) composed broker summary: pendências, tendência 2-janela, dificuldades_repetidas, `sinais_de_risco` descritivos (sem score) |
| `list_brokers_needing_attention` | `(as_agent, since?='7d', risk_levels?=['atencao','risco','critico'], equipes?, min_pendencias?, min_dificuldades_repetidas?, limit?=20, order?='priority')` | (read) portfolio scan. `priority_score = dias + pendencias×3 + dificuldades_repetidas×2 + nivel_atencao_weight`. `since` accepts relative (`^\d+[dwmy]$`) or ISO-8601 |
| `upsert_shared_context` | `(as_agent, topic, slug, title, content, tags?)` | `_shared/context/<topic>/<as_agent>/<slug>.md` |
| `upsert_entity_profile` | `(as_agent, entity_type, entity_name, content, tags?, status?)` | `_agents/<as_agent>/<entity_type>/<slug>.md` |
| `search_by_tag` | `(tag, owner?, since?, until?)` | (read) |
| `search_by_type` | `(type, owner?, since?, until?)` | (read) |
| `get_backlinks` | `(note_name)` | (read) |

### Workflows — Lead pattern (3) — Plan 2

First-class support for `entity_type=lead` per spec §5.5. Docs follow 5-section convention: Resumo / Interesse atual / Objeções ativas / Próximo passo / Histórico de interações. Lead-specific frontmatter: `status_comercial`, `origem`, `interesse_atual`, `objecoes_ativas`, `proximo_passo`.

| Tool | Signature | Writes to |
|---|---|---|
| `upsert_lead_timeline` | `(as_agent, lead_name, resumo?, interesse_atual?, objecoes_ativas?, proximo_passo?, status_comercial?, origem?, tags?)` | `_agents/<as_agent>/lead/<slug>.md` — merges with prior, preserves Histórico |
| `append_lead_interaction` | `(as_agent, lead_name, channel, summary, origem?, objection?, next_step?, tags?, timestamp?)` | appends `## YYYY-MM-DD HH:MM` block to Histórico de interações |
| `read_lead_history` | `(as_agent, lead_name, since?, limit?, order?='desc')` | (read) lead headers + interactions; warnings on malformed blocks |

### Workflows — Broker pattern (3) — Plan 3

First-class support for `entity_type=broker` per spec §5.6. Docs follow 5-section convention: Resumo / Comunicação / Padrões de atendimento / Pendências abertas / Histórico de interações. Broker-specific frontmatter: `equipe`, `nivel_engajamento`, `comunicacao_estilo`, `contato_email`, `contato_whatsapp`, `dificuldades_recorrentes`, `padroes_atendimento`, `pendencias_abertas`.

| Tool | Signature | Writes to |
|---|---|---|
| `upsert_broker_profile` | `(as_agent, broker_name, resumo?, comunicacao?, padroes_atendimento?, pendencias_abertas?, equipe?, nivel_engajamento?, comunicacao_estilo?, contato_email?, contato_whatsapp?, dificuldades_recorrentes?, tags?)` | `_agents/<as_agent>/broker/<slug>.md` — merges with prior, preserves Histórico |
| `append_broker_interaction` | `(as_agent, broker_name, channel, summary, contexto_lead?, dificuldade?, encaminhamento?, tags?, timestamp?)` | appends `## YYYY-MM-DD HH:MM` block; `contexto_lead` anchors to a lead slug without aglutinating contexts |
| `read_broker_history` | `(as_agent, broker_name, since?, limit?, order?='desc')` | (read) broker headers + interactions; warnings on malformed blocks |

### Git (2)

| Tool | Signature | Notes |
|---|---|---|
| `commit_and_push` | `(message)` | prefixed `[mcp-obsidian]`; coordinated with `brain-sync.sh` via `flock` |
| `git_status` | `()` | modified/untracked/ahead/behind |

## Resources (2)

- `obsidian://vault` — stats snapshot (JSON)
- `obsidian://agents` — ownership map (JSON)

## Broker isolation (§5.7)

`*_broker_*` tools operate on **one `broker_name` per call** — no cross-broker aggregation. This is a design convention, not a technical enforcement. Agents that attend multiple brokers (e.g. FamaAgent) must keep broker contexts separate in their own reasoning; the MCP helps by refusing to bundle them.

Plan 7 added `get_broker_operational_summary` and `list_brokers_needing_attention` (see "Broker executive views" section below) — both operate over multiple brokers at the read-aggregation layer without aglutinating contexts: each broker's parsed body remains isolated per result entry.

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

## Troubleshooting

| Error code | Cause | Fix |
|---|---|---|
| `OWNERSHIP_VIOLATION` | `as_agent` ≠ file owner per AGENTS.md | pass correct `as_agent` |
| `UNMAPPED_PATH` | path not covered by any pattern in AGENTS.md | add pattern to `_shared/context/AGENTS.md` |
| `INVALID_FILENAME` | file not kebab-case `.md` | rename to lowercase + hyphens |
| `INVALID_FRONTMATTER` | missing/malformed required field | check spec §5.1 |
| `INVALID_OWNER` | owner filter references unknown agent | check `obsidian://agents` |
| `IMMUTABLE_TARGET` | tried to write/append to `decisions.md` directly | use `append_decision` |
| `JOURNAL_IMMUTABLE` | tried to overwrite existing journal | use `append_to_note` |
| `NOTE_NOT_FOUND` | path does not exist | check path / index age |
| `LEAD_NOT_FOUND` | lead doc does not exist | run `upsert_lead_timeline` first |
| `MALFORMED_LEAD_BODY` (warn) | interaction block header doesn't match `## YYYY-MM-DD HH:MM` or has malformed `Chave: valor` line | fix the block in the file; `read_lead_history` skips it and reports in `warnings[]` |
| `BROKER_NOT_FOUND` | broker doc does not exist | run `upsert_broker_profile` first |
| `MALFORMED_BROKER_BODY` (warn) | interaction block malformed | `read_broker_history` skips + reports in `warnings[]` |
| `INVALID_TIME_RANGE` | `since`/`until` malformed ISO-8601 or `since > until` | check datetime format |
| `INVALID_PERIOD` | `period` / `since` / `until` not `YYYY-MM` in financial tools | use `YYYY-MM` (e.g. `2026-04`) |
| `SNAPSHOT_NOT_FOUND` | `read_financial_series(periods=[...])` with missing entry | use `since`/`until` for silent omit, or upsert missing period first |
| `INVALID_RELATIVE_TIME` | `since?` in `list_brokers_needing_attention` not `^\d+[dwmy]$` and not ISO-8601 | use `'7d'`/`'30d'`/`'1w'`/`'2m'`/`'1y'` or full ISO-8601 datetime |
| `GIT_LOCK_BUSY` | cron or peer holds lock | retry after 3-10s |
| `GIT_PUSH_FAILED` | remote push error | check network / remote state |
| `VAULT_IO_ERROR` | generic filesystem error or git config missing | check logs |

## Governance (§1.1 summary)

The vault is **memória operacional** for agents: contexts, decisions, operational patterns. It is **not** a CRM/financial system replacement. Detailed customer data, transactions, and compliance records live in the official systems. When vault fields and official systems diverge, the official system wins.

Plans 1-7 cover cross-agent heartbeat deltas, regressões, financial snapshots, and executive views — see `docs/superpowers/plans/`. The 34-tool spec is now complete.
