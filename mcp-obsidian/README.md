# mcp-obsidian

MCP server exposing the fama-brain Obsidian vault to LLM agents with ownership enforcement, append-only decision trail, and git-coordinated sync with the `brain-sync.sh` cron.

This repo implements **Plan 1 (Foundation + Core)** of the design at `docs/superpowers/specs/2026-04-15-mcp-obsidian-design.md`. Plans 2-7 add lead/broker first-class tools, heartbeat/delta tools, regressões, financial snapshots, and executive views.

## Quickstart

    cp .env.example .env   # then edit: set API_KEY, VAULT_PATH
    docker compose up --build
    curl -sH "Authorization: Bearer $API_KEY" -X POST localhost:3201/mcp \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

Expected output: `22`. Healthcheck: `curl localhost:3201/health` (no auth).

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

## Tools (22)

### CRUD (8)

| Tool | Signature | Notes |
|---|---|---|
| `read_note` | `(path)` | frontmatter + body + wikilinks + backlinks_count + bytes + mtime |
| `write_note` | `(path, content, frontmatter, as_agent)` | creates/overwrites; blocks `decisions.md` |
| `append_to_note` | `(path, content, as_agent)` | appends; blocks `decisions.md` |
| `delete_note` | `(path, as_agent, reason)` | mandatory reason for audit log |
| `list_folder` | `(path, recursive?, filter_type?, owner?, cursor?, limit?)` | paginated; owner = string \| string[] |
| `search_content` | `(query, path?, type?, tag?, owner?, cursor?, limit?)` | ripgrep-powered |
| `get_note_metadata` | `(path)` | frontmatter + links + backlinks + bytes |
| `stat_vault` | `()` | total_notes, by_type, by_agent, index_age_ms |

### Workflows (12)

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
| `search_by_tag` | `(tag, owner?)` | (read) |
| `search_by_type` | `(type, owner?)` | (read) |
| `get_backlinks` | `(note_name)` | (read) |

### Git (2)

| Tool | Signature | Notes |
|---|---|---|
| `commit_and_push` | `(message)` | prefixed `[mcp-obsidian]`; coordinated with `brain-sync.sh` via `flock` |
| `git_status` | `()` | modified/untracked/ahead/behind |

## Resources (2)

- `obsidian://vault` — stats snapshot (JSON)
- `obsidian://agents` — ownership map (JSON)

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
| `GIT_LOCK_BUSY` | cron or peer holds lock | retry after 3-10s |
| `GIT_PUSH_FAILED` | remote push error | check network / remote state |
| `VAULT_IO_ERROR` | generic filesystem error or git config missing | check logs |

## Governance (§1.1 summary)

The vault is **memória operacional** for agents: contexts, decisions, operational patterns. It is **not** a CRM/financial system replacement. Detailed customer data, transactions, and compliance records live in the official systems. When vault fields and official systems diverge, the official system wins.

This repo implements Plan 1 only. Subsequent plans add first-class support for leads, brokers, financial snapshots, etc. — see `docs/superpowers/plans/`.
