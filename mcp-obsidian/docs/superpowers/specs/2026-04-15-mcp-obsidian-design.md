# mcp-obsidian — Design Spec

- **Data:** 2026-04-15
- **Autor:** Renato Faria (via brainstorming com Claude)
- **Status:** Aprovado, pronto para implementação
- **Repositório alvo:** `/root/mcp-fama/mcp-obsidian/`
- **Vault alvo:** `/root/fama-brain/` (Obsidian, sync via git)

## 1. Objetivo

Criar um MCP Server em TypeScript para gerenciamento do vault Obsidian `fama-brain`, expondo leitura, escrita e navegação do vault a agentes LLM de forma segura, com enforcement automático das convenções do vault (ownership, frontmatter, kebab-case, append-only de decisões, imutabilidade de journals).

O MCP deve ser consistente com os outros MCPs do repositório (`mcp-postgres`, `mcp-minio`, `mcp-financas`) em stack, padrão de auth e deploy.

## 2. Decisões principais

| Tópico | Escolha |
|---|---|
| Camadas de tools | Híbrido — CRUD genérico + Workflows + Git |
| Transporte | Streamable HTTP (stateless JSON), igual aos outros MCPs |
| Auth | Bearer token via env `API_KEY` |
| Deploy | Docker Compose + Nginx reverse proxy em `mcp-obsidian.famachat.com.br` |
| Frontmatter | Schema estrito em Zod, discriminated union por `type` |
| Filenames | kebab-case, sem acentos, ASCII-fold idempotente |
| Ownership | `as_agent` obrigatório em toda escrita, hard block em violação |
| Ownership reload | Lazy `stat mtime` em `_shared/context/AGENTS.md` (fonte canônica única) |
| Git sync | Cron `brain-sync.sh` (5 min) é o **sync primário**; `commit_and_push(message)` sob demanda só quando o agente precisa de propagação imediata |
| Git lock | `flock /tmp/brain-sync.lock` (compartilhado com cron) timeout 3s |
| Busca | Híbrido leve — índice em memória (tags/type/backlinks) + ripgrep (full-text) |
| Invalidação do índice | `stat mtime` lazy, sem watcher |
| Logs | stdout JSON estruturado, eventos de audit com `audit: true` |

## 3. Arquitetura

### 3.1 Estrutura do projeto

```
mcp-obsidian/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
└── src/
    ├── index.ts            # HTTP bootstrap + Streamable transport
    ├── server.ts           # registerTools/Resources
    ├── config.ts           # env, VAULT_PATH, API_KEY, lockfile, git author
    ├── auth.ts             # Bearer middleware
    ├── middleware/         # rate limit, helmet, request-id, logging
    ├── vault/
    │   ├── fs.ts           # read/write atômico, ASCII-fold, path traversal guard
    │   ├── frontmatter.ts  # parse/serialize YAML + Zod schemas
    │   ├── ownership.ts    # carrega mapa de _shared/context/AGENTS.md, valida as_agent
    │   ├── index.ts        # índice em memória (tags, type, wikilinks, backlinks)
    │   └── git.ts          # commit_and_push com flock
    ├── tools/
    │   ├── crud.ts         # Camada 1
    │   ├── workflows.ts    # Camada 2
    │   └── sync.ts         # Camada 3
    └── resources/
        └── vault.ts        # obsidian://vault, obsidian://agents
```

### 3.2 Stack

- TypeScript 5.x, Node 20+
- `@modelcontextprotocol/sdk` (matching versão dos outros MCPs)
- `express`, `helmet`, `express-rate-limit`
- `zod` para schemas
- `gray-matter` ou equivalente para frontmatter YAML
- `simple-git` ou `child_process` para operações git
- `proper-lockfile` ou `flock` (binário) para serialização com cron
- `vitest` para testes

### 3.3 Config (`.env`)

```
PORT=3201
API_KEY=<bearer token>
VAULT_PATH=/vault
RATE_LIMIT_RPM=300
GIT_AUTHOR_NAME=mcp-obsidian
GIT_AUTHOR_EMAIL=mcp@fama.local
GIT_LOCKFILE=/tmp/brain-sync.lock
STRICT_WIKILINKS=false
LOG_LEVEL=info
```

### 3.4 Deploy

```yaml
# docker-compose.yml
services:
  mcp-obsidian:
    build: .
    ports: ["3201:3201"]
    environment:
      - API_KEY=${API_KEY}
      - VAULT_PATH=/vault
    volumes:
      - /root/fama-brain:/vault:rw
      - /tmp/brain-sync.lock:/tmp/brain-sync.lock
      - ./logs:/app/logs
    restart: unless-stopped
```

Nginx:
- Domínio: `mcp-obsidian.famachat.com.br`
- HTTPS via Let's Encrypt/certbot (mesmo padrão dos demais MCPs)
- Reverse proxy `localhost:3201`

Healthcheck `GET /health` isento de auth, retorna `{status, vault_notes, index_age_ms, git_head, last_write_ts}`. `last_write_ts` é o timestamp ISO-8601 da última escrita bem-sucedida — útil para detectar "MCP vivo mas silencioso há tempo demais".

## 4. Tool surface (19 tools + 2 resources)

### 4.1 Camada 1 — CRUD genérico

| Tool | Params | Retorno | Notas |
|---|---|---|---|
| `read_note` | `path` | `{frontmatter, content, path, wikilinks, backlinks_count, bytes, updated}` | readOnly |
| `write_note` | `path, content, frontmatter, as_agent` | `{path, created, sha?}` | Cria/sobrescreve. Valida ownership + frontmatter. Kebab-case + ASCII-fold |
| `append_to_note` | `path, content, as_agent` | `{path, bytes_appended}` | Bloqueado em `decisions.md` e journals existentes |
| `delete_note` | `path, as_agent, reason` | `{path, deleted: true, reason}` | `reason` obrigatório, logado no audit + commit message. destructiveHint |
| `list_folder` | `path, recursive?, filter_type?, cursor?, limit?` | `{items: [{path, type, owner, updated, tags}], next_cursor?}` | readOnly, paginado |
| `search_content` | `query, path?, type?, tag?, cursor?, limit?` | `{matches: [{path, line, preview}], next_cursor?}` | Ripgrep wrapper, readOnly |
| `get_note_metadata` | `path` | `{frontmatter, wikilinks, backlinks, bytes}` | readOnly, usa índice |
| `stat_vault` | — | `{total_notes, by_type, by_agent, index_age_ms, last_sync}` | readOnly |

### 4.2 Camada 2 — Workflows

| Tool | Params | Retorno | Notas |
|---|---|---|---|
| `create_journal_entry` | `agent, title, content, tags?` | `{path, created}` | Path `_agents/<agent>/journal/YYYY-MM-DD-<title-kebab>.md`. `as_agent` = `agent` |
| `append_decision` | `agent, title, rationale, tags?` | `{path, prepended: true}` | **Prepend** (topo) em `_agents/<agent>/decisions.md`. Append ao histórico = prepend no arquivo. Bloco `## YYYY-MM-DD — <title>\n\n<rationale>` |
| `update_agent_profile` | `agent, content` | `{path}` | Reescreve `_agents/<agent>/profile.md`, preserva frontmatter |
| `upsert_goal` | `agent, period, content` | `{path, created_or_updated}` | `period` = `YYYY-MM`. Path `_shared/goals/<period>/<agent>.md` |
| `upsert_result` | `agent, period, content` | Igual goal | `_shared/results/<period>/<agent>.md` |
| `read_agent_context` | `agent, n_decisions?=5, n_journals?=5` | `{profile, decisions, journals, goals, results}` | readOnly. Bundle único = contexto completo |
| `search_by_tag` | `tag` | `{notes: [{path, type, owner}]}` | readOnly, índice |
| `search_by_type` | `type` | Igual | readOnly, índice |
| `get_backlinks` | `note_name` | `{notes: [{path, line}]}` | readOnly, índice |

### 4.3 Camada 3 — Git

| Tool | Params | Retorno | Notas |
|---|---|---|---|
| `commit_and_push` | `message` | `{sha, branch, pushed}` | Opcional — o cron `brain-sync.sh` (5 min) já é o sync primário. Use apenas quando o agente precisa que a mudança propague imediatamente (ex: outro agente em outra VPS vai ler em seguida). `flock` 3s timeout compartilhado com o cron. Commit msg `[mcp-obsidian] <message>`. Erros: `GIT_LOCK_BUSY`, `GIT_PUSH_FAILED` |
| `git_status` | — | `{modified, untracked, ahead, behind}` | readOnly |

**Trade-off aceito — commits "mistos" sob concorrência:** `commit_and_push` serializa via `flock`, mas `git add .` captura todas as mudanças pendentes do vault no momento do commit — inclusive escritas de outros agentes que ainda não foram commitadas. Resultado possível: um commit com mensagem `[mcp-obsidian] <A>` contém também mudanças temáticas de B. Não há corrupção e o histórico permanece linear; a mensagem fica apenas imprecisa. Agrupar por `as_agent` adicionaria complexidade real ao lock por ganho cosmético — fica como upgrade path se virar problema operacional.

### 4.4 Resources MCP

- `obsidian://vault` — estatísticas (igual `stat_vault`)
- `obsidian://agents` — mapa de ownership atual (para agentes se auto-localizarem)

### 4.5 Annotations

- `readOnlyHint: true` em todas as tools de leitura.
- `destructiveHint: true` em `delete_note`.
- `idempotentHint: true` em `upsert_*`, `update_agent_profile`, `get_note_metadata`.
- `openWorldHint: false` (vault é fechado).

## 5. Validação

### 5.1 Frontmatter — Base schema

**Regra universal:** todo arquivo `.md` do vault tem frontmatter YAML obrigatório — sem exceções. Escritas sem frontmatter, ou com campos base ausentes, retornam `INVALID_FRONTMATTER`. Leituras de arquivos legados sem frontmatter retornam o conteúdo com `frontmatter: null` + warning no log para remediação manual.

```ts
BaseFrontmatter = {
  type: enum('moc','context','agents-map','goal','goals-index',
             'result','results-index','agent-readme','agent-profile',
             'agent-decisions','journal'),
  owner: string,              // validado contra ownership map
  created: YYYY-MM-DD,        // preservado em updates
  updated: YYYY-MM-DD,        // auto-atualizado em toda escrita
  tags: string[]              // kebab-case, flat
}
```

Extensões por `type` via discriminated union:
- `journal`: **frontmatter YAML obrigatório** como qualquer outro tipo (o vault atual tem journals vazios; a partir do MCP toda nova entrada nasce com frontmatter). `title` opcional, coerente com o filename.
- `goal` / `result`: `period: YYYY-MM` obrigatório. O MCP **injeta `period` automaticamente** em toda escrita de `goal`/`result`, derivando-o do path (`_shared/goals/<period>/<agent>.md`). Agentes não precisam informá-lo; se o campo chegar no payload e divergir do path, o MCP corrige para o valor do path e registra warning.
- Demais tipos: sem campos extras obrigatórios.

### 5.2 Filename

- Regex geral: `^[a-z0-9][a-z0-9-]*\.md$`
- Journal: `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$`
- ASCII-fold automático (`decisão` → `decisao`)
- Fold é idempotente e o path normalizado é retornado na resposta

### 5.3 Regras especiais

- `decisions.md`: escrita direta bloqueada (`IMMUTABLE_TARGET`). Única via é `append_decision`. Ordering é "mais recente no topo" detectado pela **data do cabeçalho do bloco** — cada decisão é um bloco `## YYYY-MM-DD — <title>` seguido do rationale. `append_decision` sempre insere o bloco novo imediatamente após o frontmatter, antes de qualquer bloco `##` existente. Validação: datas dos cabeçalhos devem estar em ordem decrescente do topo para o fim; quebra gera warning mas não bloqueia (histórico legado).
- Journals existentes: `write_note` bloqueado com `JOURNAL_IMMUTABLE`; só `append_to_note` (ou create via `create_journal_entry`). Mensagem: `Journal entries are append-only after creation. Use append_to_note instead.`
- Wikilinks quebrados: warning por default, block opcional via `STRICT_WIKILINKS=true`

### 5.4 Ownership

1. **Boot:** parse de `_shared/context/AGENTS.md` → tabela `pattern → agent`. Essa é a fonte canônica única de ownership; o `README.md` raiz é MOC/navegação e não é consultado para ownership. Suporta globs (`_agents/ceo/**` → `ceo`, `_shared/results/index.md` → `ceo`, etc).
2. **Lazy reload:** em toda escrita, `stat mtime` em `_shared/context/AGENTS.md`; se mudou, re-parse.
3. **Validação:** `resolveOwner(path)` → `agent | null`. Se `as_agent !== owner`, `OWNERSHIP_VIOLATION`.

Erro exemplar:
> `File '_agents/ceo/decisions.md' is owned by 'ceo', not 'cto'. Use as_agent='ceo' ou escreva em _agents/cto/.`

## 6. Respostas e erros

### 6.1 Formato dual

Toda tool retorna:
- `content: [{ type: "text", text: <markdown preview> }]`
- `structuredContent: { ... }` — JSON consumível

### 6.2 Erros tipados

| Code | Retry? |
|---|---|
| `OWNERSHIP_VIOLATION` | não |
| `INVALID_FRONTMATTER` | não (agente corrige) |
| `INVALID_FILENAME` | não |
| `IMMUTABLE_TARGET` | não |
| `JOURNAL_IMMUTABLE` | não (agente usa `append_to_note`) |
| `NOTE_NOT_FOUND` | não |
| `WIKILINK_TARGET_MISSING` (warn) | — |
| `GIT_LOCK_BUSY` | sim (3-10s) |
| `GIT_PUSH_FAILED` | condicional |
| `VAULT_IO_ERROR` | condicional |

Shape: `isError: true` + `structuredContent.error = {code, message, suggestion}`.

### 6.3 Logs

- stdout JSON estruturado.
- Níveis: `info`, `warn`, `error`, `audit` (campo `audit: true`).
- Cada entrada: `timestamp, request_id, tool, as_agent, path, duration_ms, outcome`.
- Audit entries (todas as escritas): `{timestamp, as_agent, tool, path, action, reason?, sha?}`.
- Persistência MVP: volume Docker `./logs:/app/logs` no host, com `audit.log` separado (append-only) para registros com `audit: true`. Logs operacionais continuam em stdout e são coletados via `docker logs`. Rotação via `logrotate` do host. Pipelines externos (Loki/journald/etc) ficam como evolução futura se surgir necessidade.

### 6.4 Paginação

- `list_folder`, `search_content`, `search_by_tag`, `search_by_type`: `cursor?: string`, `limit?: number` (default 50, max 200).
- `next_cursor` opaco (base64 de `{offset, query_hash}`).

### 6.5 Rate limit

- `express-rate-limit`, `RATE_LIMIT_RPM=300` default.
- `/health` isento.

## 7. Performance targets

| Operação | Target |
|---|---|
| `read_note`, `get_note_metadata` | < 50ms |
| `search_by_tag`, `get_backlinks` | < 50ms |
| `search_content` (ripgrep) | < 500ms (vault < 10k notas) |
| Writes (sem push) | < 100ms |
| `commit_and_push` | < 3s (dominado por rede) |
| Build inicial do índice (boot) | < 2s para vault atual |

## 8. Testes

### 8.1 Unitários (vitest)

- `frontmatter.ts`: parse/serialize round-trip; rejeição de schemas inválidos; preservação de campos extras; idempotência.
- `ownership.ts`: resolução por path/glob; reload on mtime change; mensagens.
- `fs.ts`: ASCII-fold idempotente; kebab-case validation; bloqueio de path traversal (`..`, symlinks suspeitos).
- `vault/index.ts`: build inicial; invalidação incremental pós-write; backlinks corretos para wikilinks múltiplos.

### 8.2 Integração (vitest + fixture)

- `test/fixtures/vault/`: mini-vault com 2 agentes (`alfa`, `beta`) e 5 notas incluindo `decisions.md` e um journal.
- `create_journal_entry` → arquivo existe, frontmatter correto, índice atualizado.
- `append_decision` → prepend correto, ordem temporal preservada, idempotência em crash parcial simulado.
- `read_agent_context` → bundle completo, respeita `n_decisions`/`n_journals`.
- Ownership cross-agent rejeitado com erro esperado.
- `commit_and_push` **mockado** (testa geração de mensagem e ordem de operações, não push real).

### 8.3 E2E smoke (contra container)

- `docker compose up` com vault efêmero → cliente MCP (ts-sdk) → `initialize` + `tools/list` → chama `read_note`, `create_journal_entry`, `commit_and_push` → teardown.
- Valida healthcheck e auth Bearer.

### 8.4 Stress concorrência (critério 5)

- 10 writes paralelos via MCP + cron `brain-sync.sh` em execução concorrente.
- **Passa quando:** zero corruption definida como — nenhum arquivo escrito falha re-parse de frontmatter; nenhum conteúdo aparece truncado; `stat_vault()` consistente; todas as escritas aparecem no git log.
- Verificação automatizada: re-parse de todas as notas tocadas + comparação de hashes esperados.

### 8.5 Coverage

- `vault/` ≥ 80%
- Geral ≥ 60%

## 9. Critérios de sucesso

1. 19 tools + 2 resources registrados e descobríveis via `tools/list`.
2. Suite de testes passa com coverage ≥ 80% em `vault/`.
3. Ownership enforcement bloqueia 100% das escritas cross-agent nos testes.
4. `read_agent_context("ceo")` retorna bundle completo em < 200ms no vault real.
5. Stress concorrência passa o critério de zero corruption (§8.4).
6. Deploy em VPS de staging + smoke test em `mcp-obsidian.famachat.com.br` passa.
7. `README.md` documenta cada tool com exemplo + troubleshooting comum (GIT_LOCK_BUSY, OWNERSHIP_VIOLATION).

## 10. Fora de escopo (YAGNI)

- Watcher (chokidar) — mtime lazy basta.
- Full-text indexing customizado — ripgrep resolve.
- Multi-vault.
- Web UI de administração.
- Métricas Prometheus.
- Backup dedicado (cron já replica via git remote).
- Pull automático antes de reads (confia no cron).
- Tipos extras além dos 12 atuais.
- Allowlist de exceções de ownership (adicionar quando surgir necessidade real).

## 11. Upgrade paths (não implementar agora)

- Ownership allowlist configurável → promove A → D sem breaking change na API das tools.
- Pull-before-read e push-after-write automáticos → promove B → D (campo `sync_mode` em config).
- Watcher → se vault crescer significativamente (> 20k notas), substitui mtime lazy.
- Strict wikilinks → flag já existe (`STRICT_WIKILINKS`), basta mudar o default.
- `move_note(from, to, as_agent)` na Camada 1 → renomeia arquivo + reescreve wikilinks de notas que apontam pra ele; idempotente (destino já existente e source ausente = sucesso). Fora do MVP porque o workflow atual (read + write + delete) funciona, apesar de quebrar wikilinks; entra quando surgir necessidade real de renomear pastas/títulos sem órfãos.
- Tokens por agente (`MCP_TOKEN_<AGENT>`) → MCP valida `as_agent` contra o token apresentado, eliminando o risco de "quem tem o token assume qualquer identidade". Modelo atual assume token tão sensível quanto senha de banco; upgrade quando o custo operacional de rotação por agente for aceitável.
- `idempotency_key` opcional em `append_decision` (e possivelmente outras writes) → cliente envia UUID; MCP deduplica dentro de janela curta para evitar entradas duplicadas quando a resposta HTTP se perde e o agente retenta.
- Commits agrupados por `as_agent` em `commit_and_push` → elimina commits "mistos" descritos em §4.3 quando virarem atrito real.
