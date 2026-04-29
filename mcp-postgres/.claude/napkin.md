# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-03-17 | self | Docker healthcheck used `localhost` which resolves to IPv6 `::1` in Alpine, but Node listens on IPv4 `0.0.0.0` | Always use `127.0.0.1` instead of `localhost` in Alpine container healthchecks |
| 2026-03-17 | self | Used `restart_policy: condition: on-failure` but graceful shutdown exits with code 0, so Swarm never restarts | Use `condition: any` when the app has graceful shutdown (SIGTERM → exit 0) |
| 2026-03-18 | self | Used stateful StreamableHTTPServerTransport with session tracking — sessions get lost on container redeploy (in-memory map), client gets stuck in 400 loop | Use stateless mode (`sessionIdGenerator: undefined`) — each POST creates fresh transport+server. No session tracking needed for independent DB queries |
| 2026-03-18 | self | SQL queries used old Portuguese column names (`corretor_id`, `data_agendamento`, `sla_expira_em`, `valor_venda`) from legacy schema | Always verify column names against `information_schema.columns` before writing queries. DB uses English names (`broker_id`, `scheduled_at`, `value`) |
| 2026-03-18 | self | Testing via Traefik (HTTPS) after container redeployment sometimes returns stale/cached responses from old containers | Always test directly inside container via `docker exec ... wget` to bypass Traefik proxy layer during debugging |
| 2026-04-27 | self | `src/db.ts` was importing pg from `'../node_modules/@types/pg/index.js'` — a TypeScript-types-only package with no runtime; container failed with ERR_MODULE_NOT_FOUND because `npm ci --omit=dev` strips @types/pg | Use `import pg from 'pg';` — works with esModuleInterop:true; pg is CJS so default export contains `{ Pool, Client, ... }` |
| 2026-04-27 | self | `docker stack deploy` did not recreate the task when image tag stayed `:latest` (Swarm sees no diff) | Use `docker service update --force <service>` to redeploy with the same tag |

## User Preferences
- User communicates in Portuguese
- VPS rarely updated — prefers simple, low-maintenance solutions

## Patterns That Work
- Docker Swarm stack deploy follows same pattern as other services (n8n, evolution, etc.)
- Traefik labels: entrypoint `websecure`, certresolver `letsencryptresolver`, network `network_public`
- Multi-stage Dockerfile: build with all deps, prod with `--omit=dev`
- Stateless MCP transport: no session management, each request is independent
- `docker exec CONTAINER wget -q -O - ... http://127.0.0.1:3100/mcp` for bypassing proxy during testing

## Patterns That Don't Work
- `docker stack deploy` does NOT support `build:` directive — must `docker build` separately
- `localhost` in Alpine containers — use `127.0.0.1`
- Stateful MCP sessions with Docker Swarm — sessions lost on redeploy, client can't recover
- Rate limiter keyed by `mcp-session-id` — undefined when no session, breaks in stateless mode
- Duplicate Docker stacks with same Traefik router name — Traefik round-robins between them silently. Always check `docker service ls | grep <name>` before debugging "intermittent" failures

## Domain Notes
- Project: mcp-postgres — MCP server for PostgreSQL (CRM Imobiliario)
- VPS: vmi1988871.contaboserver.net, Docker Swarm
- Domain: famachat.com.br (subdominios via Registro.br)
- MCP endpoint: https://mcp-famachat-postgres.famachat.com.br/mcp
- DB: postgres_postgres service on network_public overlay
- DB schema uses English column names (broker_id, scheduled_at, value) not Portuguese (corretor_id, data_agendamento, valor_venda)
- Table `sistema_leads` has no SLA columns — sla_expira_em query was removed from daily_report
- Tool count after 2026-04-27 update: 75 tools + 2 resources (was 40). New domain modules: webhooks, automacao, auth (audit/sessions), reminders (full lifecycle, see below). New write tools: create_lead/update_lead/assign_lead, create_appointment/update_appointment, create_visit, create_sale, manage_list, add_task_comment
- Reminders module is a complete worker queue (16 tools): list/get/create/update/cancel + entity-bulk variants (list_/create_/reschedule_/cancel_entity_reminders) + worker callbacks (claim_next_due_reminder, mark_reminder_sent/failed/skipped, release_stuck_reminders)
- Reminders partial unique index `unique_active_reminder_key` requires the EXACT predicate in ON CONFLICT: `WHERE status = ANY (ARRAY['Pending','Processing']) AND idempotency_key IS NOT NULL` — using `IN (...)` shorthand fails with "no unique or exclusion constraint matching the ON CONFLICT specification"
- Idempotency key convention used by famachat reminders: `{entity_type}:{entity_id}:recipient:{recipient_type}:{recipient_id}:{template_key}:{channel}`
- For COALESCE($a, $b) with two parametrized binds in pg, the driver defaults bind types to text, causing "column X is of type integer but expression is of type text" errors when the column is non-text. Either compute the value in JS first (cleanest), or cast like `COALESCE($a::int, $b::int)`
- Production famachat reminder worker is running and races with manual mark_skipped calls in tests — saw a notification_log row with status="Sent" (capital S) appear right after my mark_skipped (lowercase). Cleanup attempts via mass DELETE on shared reminders/notification_logs are policy-blocked; leave terminal-state test rows in place (entity_type starts with "test_")
