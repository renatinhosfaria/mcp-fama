# mcp-obsidian

MCP server that exposes the `fama-brain` Obsidian vault to LLM agents over stateless Streamable HTTP. It enforces vault ownership, Schema v1 routing, immutable journal/decision writes, Reno-specific wikilink policy, and git-coordinated sync through an in-process worker.

Current public surface: **45 tools + 2 resources**.

## Quickstart

```bash
cp .env.example .env
# edit API_KEY and VAULT_PATH
docker compose up --build

curl -sH "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -X POST localhost:3201/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools | length'
```

Expected tool count: `45`.

Healthcheck does not require auth:

```bash
curl localhost:3201/health
```

## Runtime

The server exposes one stateless MCP endpoint:

- `POST /mcp` - JSON-RPC MCP requests, protected by `Authorization: Bearer <API_KEY>`.
- `GET /health` - health, vault index size, git head, last write timestamp, and sync worker status.

Main environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3201` | HTTP listen port. |
| `API_KEY` | required | Bearer token for `/mcp`. |
| `API_KEY_FILE` | unset | Optional file-based API key; takes precedence when readable. |
| `VAULT_PATH` | required | Vault root path. In Docker this is `/vault`. |
| `RATE_LIMIT_RPM` | `300` | Per-process request rate limit. |
| `SYNC_ENABLED` | `true` | Enables the in-process git sync worker. |
| `SYNC_INTERVAL_MS` | `30000` | Sync worker tick interval. |
| `GIT_REMOTE` | `origin` | Remote used by sync worker. |
| `GIT_BRANCH` | `main` | Branch used by sync worker. |
| `LEGACY_TOOL_MODE` | `redirect` | Legacy alias behavior where supported: `redirect` or `error`. |
| `HUMAN_VERIFIERS` | empty | Comma-separated verifier names for trust filtering. |
| `DEFAULT_AGENT_SOURCE` | `agent-generated` | Default Schema v1 source for agent writes. |

## Development

```bash
npm install
API_KEY=t VAULT_PATH=/path/to/vault npm run dev
npm run typecheck
npm test
npm run build
```

The Docker image installs `git`, `ripgrep`, `openssh-client`, and `util-linux`, then runs `node dist/index.js`.

## Git Sync

Writes enqueue commit jobs. The sync worker periodically fetches, reconciles, commits MCP-written paths, and pushes to GitHub. If a remote change overlaps an MCP-written path, MCP changes win for that path and the conflict is logged in worker status.

Deploy key setup:

```bash
ssh-keygen -t ed25519 -C "mcp-obsidian-deploy@$(hostname)" \
  -f /root/.ssh/fama-brain-deploy -N ""

git -C /root/fama-brain remote set-url origin git@github.com:renatinhosfaria/fama-brain.git
ssh -T git@github.com -i /root/.ssh/fama-brain-deploy
```

Register `/root/.ssh/fama-brain-deploy.pub` as a GitHub deploy key with write access.

## Vault Model

Schema v1 writes are routed by type:

| Type | Destination |
|---|---|
| `journal`, `interaction` | `_journal/<agent>/YYYY-MM-DD-<slug>.md` |
| `decision` | `_decisions/<YYYY-MM-DD[-agent]-slug>.md` |
| `entity` | `_entities/<slug>.md` |
| `hub` | `_hubs/<slug>.md` |
| `runbook` | `_runbooks/<slug>.md` |
| `concept`, `reference`, `project` | `_meta/` |
| `goal` | `_shared/goals/<period>/<agent>.md` |
| `result` | `_shared/results/<period>/<agent>.md` |

The legacy `_agents/` namespace is read-only for new writes. Useful legacy tools now redirect to Schema v1 destinations; `_agents/` remains readable for historical notes only.

## Ownership

`_shared/context/AGENTS.md` in the vault root must contain fenced code blocks with lines like:

```text
_journal/reno/**                         => reno (primary)
_decisions/*-reno-*.md                   => reno (primary)
_runbooks/reno-*.md                      => reno (primary)
_entities/**                             => renato (primary) | reno (confirmed-facts) | marketing (confirmed-facts)
_shared/context/AGENTS.md                => renato
```

Qualified actors are supported:

```text
_agents/ceo/** => ceo (primary) | vault-steward (structural-only)
```

First matching glob wins. The primary actor is used as the indexed owner; secondary actors are allowed by `ownerCheck`. Delegated entity authors may write confirmed facts, but cannot set `verified_by`, `verified_at`, `superseded_by`, or `source: human-curated`.

### `vault_admin`

`as_agent: "vault_admin"` bypasses ownership and unmapped-path checks. It does not bypass frontmatter validation, filename/path safety, immutability, legacy namespace removal, or other write policies.

## Reno Strict Wikilinks

Every new Schema v1 note created by `reno` must include at least one resolved Obsidian wikilink (`[[...]]`) to an existing vault note. The link may appear in frontmatter (`participants`, `mentions_entity`, `related`, etc.) or in the Markdown body.

Examples that satisfy the rule:

```yaml
related:
  - '[[reno-hub]]'
mentions_entity:
  - '[[union-vereda]]'
```

The rule applies only on create. Updates to existing notes and support notes (`README.md`, `index.md`) are exempt. Links to missing targets such as `[[cliente-11379]]` do not satisfy the rule; create or resolve the canonical entity first.

`validate_note` and `validate_vault` report `wikilink_required` for existing Reno Schema v1 notes without a resolved wikilink. Creation failures return `WIKILINK_TARGET_MISSING`.

## Tools

### Core CRUD

| Tool | Purpose |
|---|---|
| `read_note` | Read note content, frontmatter, wikilinks, trust, metadata. |
| `write_note` | Create/overwrite a non-immutable note; enforces routing, ownership, and Reno wikilink policy. |
| `append_to_note` | Append to a mutable note. |
| `delete_note` | Delete a note with an audit reason. |
| `list_folder` | List indexed notes with filters, pagination, owners, and mtime windows. |
| `search_content` | Ripgrep full-text search with type/tag/owner/trust/time filters. |
| `get_note_metadata` | Read indexed frontmatter, wikilinks, backlinks, and byte size. |
| `stat_vault` | Return note count, counts by type/agent, index age, and last sync placeholder. |

### Validation And Lookup

| Tool | Purpose |
|---|---|
| `validate_note` | Validate one note for frontmatter, Schema v1 routing, ownership, and Reno wikilinks. |
| `validate_vault` | Audit indexed notes and return fixed finding categories/counts. |
| `scan_sensitive_data` | Read-only scan for sensitive data; returns category counts and redacted examples only. |
| `find_entity_by_external_id` | Find `_entities/*.md` notes by `external_ids.<key> == value`. |
| `search_by_tag` | Indexed tag search with owner/time/trust filters. |
| `search_by_type` | Indexed type search with owner/time/trust filters. |
| `get_backlinks` | Return notes linking to a note name/stem. |

Validation categories are: `schema_error`, `ownership_violation`, `legacy_namespace`, `broken_link`, `wikilink_required`, `trust_gap`, `index_policy_gap`, `routing_gap`, `frontmatter_missing`.

### Schema V1 Writes

| Tool | Destination / Behavior |
|---|---|
| `create_journal_event` | Creates write-once `_journal/<agent>/<date>-<slug>.md`; `channel + participants` makes `type: interaction`. |
| `record_decision` | Creates write-once `_decisions/...md`; Reno filenames include `reno`. |
| `create_or_update_entity` | Creates/updates `_entities/<slug>.md`; Reno cannot set protected verification fields or change canonical name/type on existing entities. |
| `update_hub` | Creates/updates `_hubs/<slug>.md`, preserving or replacing `Summary`/`Related` sections outside fenced code. |
| `upsert_runbook` | Creates/updates `_runbooks/<slug>.md`; Reno may only write `reno-*` slugs. |
| `upsert_shared_context` | Writes `_shared/context/<topic>/<as_agent>/<slug>.md`. |
| `upsert_goal` | Writes `_shared/goals/<period>/<agent>.md`. |
| `upsert_result` | Writes `_shared/results/<period>/<agent>.md`. |
| `upsert_financial_snapshot` | Writes `_shared/financials/<period>/<agent>.md`; merges 5 financial sections and summary fields. |

### Reads And Operational Views

| Tool | Purpose |
|---|---|
| `read_agent_context` | Bundle v1 territory for one agent: hub, profile, decisions, journals/interactions, runbooks, projects, shared context, goals, and results. |
| `get_agent_delta` | Group an agent's changed notes since an ISO timestamp. |
| `get_shared_context_delta` | Group shared-context updates since a timestamp, optionally by topic/owner. |
| `get_training_target_delta` | Combine target-agent delta, shared-about-target notes, and regression projections. |
| `read_financial_series` | Read parsed financial snapshots by explicit periods or period range. |
| `get_broker_operational_summary` | Summarize one broker profile with recent interactions and descriptive risk signals. |
| `list_brokers_needing_attention` | Portfolio scan over broker profiles with fixed `priority_score`. |

### Legacy Compatibility

| Tool | Current behavior |
|---|---|
| `create_journal_entry` | Redirects to `create_journal_event` unless `LEGACY_TOOL_MODE=error`. |
| `upsert_entity_profile` | Redirects to `create_or_update_entity` unless `LEGACY_TOOL_MODE=error`. |
| `upsert_hub` | Redirects to `update_hub` unless `LEGACY_TOOL_MODE=error`. |
| `append_decision` | Deprecated error; use `record_decision`. |
| `update_agent_profile` | Updates `_runbooks/<agent>-profile.md` when present; otherwise writes `_shared/context/<agent>/profile.md`. |
| `upsert_lead_timeline` | Writes the lead state to `_entities/<slug>.md`; never creates `_agents/` notes. |
| `append_lead_interaction` | Creates a linked `_journal/<agent>/...md` interaction event. |
| `read_lead_history` | Reads v1 entity + journal events, with fallback to existing legacy lead docs. |
| `upsert_broker_profile` | Writes the broker state to `_entities/<slug>.md`; never creates `_agents/` notes. |
| `append_broker_interaction` | Creates a linked `_journal/<agent>/...md` interaction event. |
| `read_broker_history` | Reads v1 entity + journal events, with fallback to existing legacy broker docs. |

### Admin And Git

| Tool | Purpose |
|---|---|
| `git_status` | Return vault git modified/untracked/ahead/behind status. |
| `bootstrap_agent` | Creates a v1 agent territory: `_hubs/<agent>-hub.md`, `_journal/<agent>/README.md`, `_projects/<agent>/README.md`, `_shared/context/<agent>/README.md`, `_runbooks/<agent>-vault-operacao.md`, and AGENTS patterns. |
| `delete_path` | Recursively delete a file or directory; disallows deleting the vault root. |

## Resources

- `obsidian://vault` - vault stats snapshot.
- `obsidian://agents` - parsed ownership map.

## Error Codes

| Code | Meaning |
|---|---|
| `OWNERSHIP_VIOLATION` | Caller is not allowed to write the path. |
| `UNMAPPED_PATH` | Path has no matching ownership rule. |
| `LEGACY_NAMESPACE_REMOVED` | Write attempted under removed `_agents/` namespace. |
| `DEPRECATED_TOOL` | Legacy tool is disabled or replaced. |
| `ROUTING_VIOLATION` | Schema v1 note type is not stored at its routed destination. |
| `PROTECTED_FIELD_VIOLATION` | Reno tried to set/change protected entity fields. |
| `INVALID_SCHEMA_V1` | Schema v1 common fields are missing or malformed. |
| `TRUST_POLICY_VIOLATION` | Trust/source policy failed. |
| `INVALID_FILENAME` | New filename/slug is invalid. |
| `INVALID_OWNER` | Unknown owner filter or reserved/invalid owner. |
| `IMMUTABLE_TARGET` | Decision already exists or immutable decision target was overwritten. |
| `JOURNAL_IMMUTABLE` | Journal event already exists or immutable journal target was overwritten. |
| `NOTE_NOT_FOUND` | Note/path does not exist. |
| `WIKILINK_TARGET_MISSING` | Reno create lacked a resolved wikilink target. |
| `LEAD_NOT_FOUND` | Legacy lead doc does not exist. |
| `BROKER_NOT_FOUND` | Legacy broker doc does not exist. |
| `MALFORMED_LEAD_BODY` | Legacy lead body had malformed interaction blocks. |
| `MALFORMED_BROKER_BODY` | Legacy broker body had malformed interaction blocks. |
| `INVALID_TIME_RANGE` | Time range is malformed or reversed. |
| `INVALID_PERIOD` | Financial period is not `YYYY-MM`. |
| `SNAPSHOT_NOT_FOUND` | Explicit financial period is missing. |
| `INVALID_RELATIVE_TIME` | Relative time such as `7d`/`1w` is malformed. |
| `GIT_LOCK_BUSY` | Git/sync lock is busy. |
| `GIT_PUSH_FAILED` | Git push failed. |
| `VAULT_IO_ERROR` | Filesystem, git, cursor, or generic vault I/O error. |

## Governance

The vault is operational memory for agents: decisions, procedures, context, entity summaries, and event history. It is not the CRM, financial ledger, or compliance system of record. When vault data and official systems diverge, official systems win.

Sensitive-data governance: `scan_sensitive_data` detects `phone_like`, `whatsapp_jid`, `email`, `cpf_like`, and `secret_keyword`. The tool must never return raw matched values; examples are redacted with category markers.
