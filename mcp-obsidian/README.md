# mcp-obsidian

MCP server exposing the fama-brain Obsidian vault to LLM agents with ownership enforcement, append-only decision trail, and git-coordinated sync with the `brain-sync.sh` cron.

This repo implements **Plans 1-3** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`:
- **Plan 1** (Foundation + Core): HTTP transport, auth, vault layer (fs, frontmatter, ownership, index, git), 22 tools + 2 resources.
- **Plan 2** (Lead pattern for Reno): `entity_type=lead` first-class with 3 tools and §5.5 body convention.
- **Plan 3** (Broker pattern for FamaAgent + temporal filters): `entity_type=broker` first-class with 3 tools and §5.6 body convention. `since`/`until` temporal filters on `list_folder`/`search_content`/`search_by_tag`/`search_by_type`. §5.7 broker isolation convention.

Plans 4-7 add heartbeat/shared-context delta (Follow-up), regressões (Sparring), financial snapshots (cfo-exec), and executive views (ceo-exec).

## Quickstart

    cp .env.example .env   # then edit: set API_KEY, VAULT_PATH
    docker compose up --build
    curl -sH "Authorization: Bearer $API_KEY" -X POST localhost:3201/mcp \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

Expected output: `28`. Healthcheck: `curl localhost:3201/health` (no auth).

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

## Tools (28)

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

### Workflows — generic (12)

| Tool | Signature | Writes to |
|---|---|---|
| `create_journal_entry` | `(agent, title, content, tags?)` | `_agents/<agent>/journal/YYYY-MM-DD-<slug>.md` |
| `append_decision` | `(agent, title, rationale, tags?)` | prepend in `_agents/<agent>/decisions.md` |
| `update_agent_profile` | `(agent, content)` | `_agents/<agent>/profile.md` body, preserves frontmatter |
| `upsert_goal` | `(agent, period, content)` | `_shared/goals/<period>/<agent>.md` (YYYY-MM) |
| `upsert_result` | `(agent, period, content)` | `_shared/results/<period>/<agent>.md` |
| `read_agent_context` | `(agent, n_decisions?, n_journals?)` | (read) profile + decisions + journals + goals + results |
| `get_agent_delta` | `(agent, since, types?, include_content?)` | (read) grouped delta since ISO datetime |
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

No `list_brokers_needing_attention` or `get_broker_operational_summary` in this plan — those come in Plan 7.

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
| `GIT_LOCK_BUSY` | cron or peer holds lock | retry after 3-10s |
| `GIT_PUSH_FAILED` | remote push error | check network / remote state |
| `VAULT_IO_ERROR` | generic filesystem error or git config missing | check logs |

## Governance (§1.1 summary)

The vault is **memória operacional** for agents: contexts, decisions, operational patterns. It is **not** a CRM/financial system replacement. Detailed customer data, transactions, and compliance records live in the official systems. When vault fields and official systems diverge, the official system wins.

Plans 4-7 will add first-class support for cross-agent heartbeat deltas, regressões, financial snapshots, and executive views — see `docs/superpowers/plans/`.
