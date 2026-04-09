# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-03-17 | self | Docker healthcheck used `localhost` which resolves to IPv6 `::1` in Alpine, but Node listens on IPv4 `0.0.0.0` | Always use `127.0.0.1` instead of `localhost` in Alpine container healthchecks |
| 2026-03-17 | self | Used `restart_policy: condition: on-failure` but graceful shutdown exits with code 0, so Swarm never restarts | Use `condition: any` when the app has graceful shutdown (SIGTERM → exit 0) |
| 2026-03-18 | self | Used stateful StreamableHTTPServerTransport with session tracking — sessions get lost on container redeploy (in-memory map), client gets stuck in 400 loop | Use stateless mode (`sessionIdGenerator: undefined`) — each POST creates fresh transport+server. No session tracking needed for independent DB queries |
| 2026-03-18 | self | SQL queries used old Portuguese column names (`corretor_id`, `data_agendamento`, `sla_expira_em`, `valor_venda`) from legacy schema | Always verify column names against `information_schema.columns` before writing queries. DB uses English names (`broker_id`, `scheduled_at`, `value`) |
| 2026-03-18 | self | Testing via Traefik (HTTPS) after container redeployment sometimes returns stale/cached responses from old containers | Always test directly inside container via `docker exec ... wget` to bypass Traefik proxy layer during debugging |

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
