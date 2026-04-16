# mcp-obsidian — Design Spec

- **Data:** 2026-04-15 (addendum 2026-04-16, addendum lead-history 2026-04-16, addendum FamaAgent 2026-04-16, addendum Follow-up 2026-04-16, addendum Sparring 2026-04-16, addendum cfo-exec 2026-04-16, addendum ceo-exec 2026-04-16)
- **Autor:** Renato Faria (via brainstorming com Claude)
- **Status:** Em revisão — sete addenda em 2026-04-16: (1) 3 tools (`get_agent_delta`, `upsert_shared_context`, `upsert_entity_profile`) + filtro `owner` nas tools de busca; (2) padrão lead first-class para o agente Reno: 3 tools (`upsert_lead_timeline`, `append_lead_interaction`, `read_lead_history`), branch `entity_type=lead` no schema, convenção de body markdown; (3) padrão broker first-class para o agente FamaAgent: 3 tools (`upsert_broker_profile`, `append_broker_interaction`, `read_broker_history`), branch `entity_type=broker`, convenção de isolamento por broker, filtros temporais (`since`/`until`) nas tools de busca, governance §1.1 (vault ≠ CRM); (4) suporte heartbeat para o agente Follow-up: 1 tool nova (`get_shared_context_delta`) para leitura incremental cross-agent, taxonomia canônica em §5.8 para tópicos de `_shared/context/` (opt-out, objeções, retomadas, aprendizados, abordagens), extensão de §1.1 cobrindo opt-out vs CRM oficial; (5) suporte para o agente Sparring (treina o Reno e outros): 1 tool nova (`get_training_target_delta`) para visão consolidada de mudanças sobre um agente alvo, 6º tópico canônico `regressoes/` em §5.8 com body convention dedicado, vocabulário canônico de tags para regressões (status/severidade/categoria/agente-alvo); (6) suporte para o agente cfo-exec: 2 tools novas (`upsert_financial_snapshot`, `read_financial_series`) para snapshots financeiros estruturados por período, novo `type: financial-snapshot` no enum, convenção de body §5.9, reafirmação governance §1.1 (snapshots são resumos operacionais textuais, não planilha financeira); (7) suporte executivo para o agente ceo-exec: 2 tools novas (`get_broker_operational_summary`, `list_brokers_needing_attention`) para síntese e priorização de carteira de corretores, extensão de §5.6 com campos `nivel_atencao?` e `ultima_acao_recomendada?` no broker schema + vocabulário canônico de níveis (`normal`, `atencao`, `risco`, `critico`).
- **Repositório alvo:** `/root/mcp-fama/mcp-obsidian/`
- **Vault alvo:** `/root/fama-brain/` (Obsidian, sync via git)

## 1. Objetivo

Criar um MCP Server em TypeScript para gerenciamento do vault Obsidian `fama-brain`, expondo leitura, escrita e navegação do vault a agentes LLM de forma segura, com enforcement automático das convenções do vault (ownership, frontmatter, kebab-case, append-only de decisões, imutabilidade de journals).

O MCP deve ser consistente com os outros MCPs do repositório (`mcp-postgres`, `mcp-minio`, `mcp-financas`) em stack, padrão de auth e deploy.

## 1.1 O que o vault É e o que NÃO é (governance)

**É:** memória de trabalho dos agentes — contexto operacional, decisões, padrões aprendidos, perfis sintéticos de entidades (lead, broker, etc.), histórico de interações com nível de detalhe suficiente para retomada de raciocínio entre sessões.

**Não é:** sistema de registro primário de dados sensíveis. Especificamente FORA de escopo do vault:

- **Dados financeiros completos de cliente** (renda detalhada, score de crédito, comprovantes) — pertencem ao CRM oficial.
- **Documentos de identificação** (CPF, RG, scans de comprovantes) — pertencem ao sistema documental oficial.
- **Status comercial canônico de pipeline** (proposta-enviada-em-X, contrato-assinado, valores fechados) — pertencem ao CRM. Os campos `status_comercial` (lead) e similares no vault são **resumos operacionais** para uso do agente, não a fonte de verdade.
- **Dados de pagamento, transações, comissões** — pertencem ao sistema financeiro.

O MCP **não enforça** essa separação tecnicamente (é convenção operacional), mas a spec a documenta explicitamente como guidance para todos os agentes. Violações repetidas indicam que falta tooling adequado no sistema oficial — escalar para o Renato em vez de improvisar persistência sensível no vault.

Risco principal mitigado: vault virar "CRM paralelo" desorganizado e sem controle de privacidade — preocupação levantada pelo FamaAgent que opera diretamente com dados de corretores e clientes.

**Opt-out merece destaque** (preocupação levantada pelo Follow-up): o vault armazena os **sinais operacionais** ("o cliente disse 'não me chame mais' por WhatsApp em data X" — quem ouviu, quando, em que contexto) como memória de trabalho, útil para todos os agentes evitarem reabordagem indevida. Mas o **registro oficial e legal** de opt-out (compliance LGPD, descadastramento de canais, listas oficiais de não-contato) pertence ao sistema oficial. Os dois devem estar alinhados; quando divergirem, o sistema oficial vence. A taxonomia canônica em §5.8 inclui o tópico `opt-out/` justamente para padronizar como esses sinais operacionais entram no vault, reduzindo o risco de interpretações divergentes entre agentes.

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
| Busca | Híbrido leve — índice em memória (tags/type/backlinks/owner/mtime) + ripgrep (full-text) |
| Invalidação do índice | `stat mtime` lazy, sem watcher |
| Logs | stdout JSON estruturado, eventos de audit com `audit: true` |
| Delta temporal | `mtime` per-note no índice; `get_agent_delta` filtra linear por `owner + mtime > since + types?` |
| Shared context layout | Path-based `_shared/context/<topic>/<agent>/<slug>.md`; ownership 100% por path (sem file-level owner) |
| Entity profile | Novo `type: entity-profile` no discriminated union; path `_agents/<agent>/<entity_type>/<slug>.md` |
| Filtro owner | `owner?: string \| string[]` opcional em `search_content`, `list_folder`, `search_by_tag`, `search_by_type` |
| Lead-history first-class | `entity_type=lead` é first-class: branch lead-específico no schema, convenção de body em §5.5, 3 tools dedicadas (`upsert_lead_timeline`, `append_lead_interaction`, `read_lead_history`) |
| Broker-history first-class | `entity_type=broker` é first-class: branch broker-específico no schema, convenção de body em §5.6, 3 tools dedicadas (`upsert_broker_profile`, `append_broker_interaction`, `read_broker_history`) |
| Isolamento por broker atendido | Tools `*_broker_*` operam sobre **um único** `broker_name` por chamada; sem aggregation cross-broker no MVP (§5.7) — disciplina via design da API, não via session state |
| Filtros temporais centrais | `since?` e `until?` (ISO-8601) opcionais em `search_content`, `search_by_tag`, `search_by_type`, `list_folder`; filtro por `mtime` (mesma fonte de `get_agent_delta`) |
| Governance vault ≠ CRM | Documentado em §1.1 — vault armazena memória operacional/contextual; dados sensíveis de cliente/comissão/documento ficam no CRM/sistema oficial. Convenção, sem enforcement técnico |
| Heartbeat read cross-agent | `get_shared_context_delta(since, topics?, owners?)` retorna shared-context escritos por **qualquer** agente desde `since`, agrupado por topic — habilita Follow-up (e similares) a perguntar "o que a equipe aprendeu desde minha última rodada?" sem reler bundle inteiro |
| Taxonomia canônica de shared context | §5.8 define 6 tópicos canônicos (`opt-out`, `objecoes`, `retomadas`, `aprendizados`, `abordagens`, `regressoes`) com semântica fixa; tópicos novos permitidos mas convenção orienta primeiro encaixar nos canônicos |
| Visão treinador→alvo | `get_training_target_delta(target_agent, since, topics?)` consolida mudanças do alvo (delta agent) + shared-context que mencionam o alvo + regressões abertas com `#alvo-<target>` — habilita Sparring a perguntar "o que mudou sobre o Reno desde minha última bateria?" em uma chamada |
| Snapshot financeiro por período | Novo `type: financial-snapshot` no enum (parallel a `goal`/`result`); path `_shared/financials/<period>/<agent>.md`; 2 tools dedicadas (`upsert_financial_snapshot`, `read_financial_series`); body convention §5.9 com 5 seções (Caixa, Receita, Despesa, Alertas, Contexto adicional); campos `*_resumo` no frontmatter para listagem comparativa rápida (uma linha cada, texto não-numérico) |
| Síntese executiva de carteira de brokers | 2 tools dedicadas (`get_broker_operational_summary`, `list_brokers_needing_attention`); broker schema ganha `nivel_atencao?` (`normal`/`atencao`/`risco`/`critico`) e `ultima_acao_recomendada?` (uma linha); priorização via `priority_score` calculado de fórmula fixa documentada (sem score composto único, sem auto-detect de mudança de nível) |

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
    │   ├── index.ts        # índice em memória (tags, type, wikilinks, backlinks, owner, mtime)
    │   ├── lead.ts         # parser/serializer do padrão lead (§5.5): header sections + blocos de interação
    │   ├── broker.ts       # parser/serializer do padrão broker (§5.6): header sections + blocos de interação
    │   ├── financial.ts    # parser/serializer do padrão financial-snapshot (§5.9): 5 seções estruturadas + auto-extract de campos *_resumo
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

## 4. Tool surface (34 tools + 2 resources)

### 4.1 Camada 1 — CRUD genérico

| Tool | Params | Retorno | Notas |
|---|---|---|---|
| `read_note` | `path` | `{frontmatter, content, path, wikilinks, backlinks_count, bytes, updated}` | readOnly |
| `write_note` | `path, content, frontmatter, as_agent` | `{path, created, sha?}` | Cria/sobrescreve. Valida ownership + frontmatter. Kebab-case + ASCII-fold |
| `append_to_note` | `path, content, as_agent` | `{path, bytes_appended}` | Bloqueado em `decisions.md` e journals existentes |
| `delete_note` | `path, as_agent, reason` | `{path, deleted: true, reason}` | `reason` obrigatório, logado no audit + commit message. destructiveHint |
| `list_folder` | `path, recursive?, filter_type?, owner?, since?, until?, cursor?, limit?` | `{items: [{path, type, owner, updated, mtime, tags}], next_cursor?}` | readOnly, paginado. `owner` = `string \| string[]` (validado contra ownership map; `INVALID_OWNER` se desconhecido). `since?`/`until?` = ISO-8601, filtra por `mtime` (mesma fonte de `get_agent_delta`); `INVALID_TIME_RANGE` se `since > until` ou formato inválido |
| `search_content` | `query, path?, type?, tag?, owner?, since?, until?, cursor?, limit?` | `{matches: [{path, line, preview, mtime}], next_cursor?}` | Ripgrep wrapper, readOnly. `owner` filtra pós-ripgrep via índice. `since?`/`until?` = ISO-8601, filtro temporal por `mtime` aplicado antes do ripgrep para reduzir scope (acelera busca) |
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
| `upsert_financial_snapshot` | `as_agent, period (YYYY-MM), caixa?, receita?, despesa?, alertas?, contexto?, caixa_resumo?, receita_resumo?, despesa_resumo?, tags?` | `{path, created_or_updated, sha?}` | Cria/atualiza `_shared/financials/<period>/<as_agent>.md` com as 5 seções §5.9. `period` valida `YYYY-MM` (`INVALID_PERIOD` se diferente). Frontmatter injeta `type=financial-snapshot`, `period`, `alertas_count` (contagem do array `alertas` recebido). Campos `*_resumo` opcionais — se ausentes, MCP gera automaticamente extraindo a primeira linha não-vazia da seção correspondente do body recebido. Update preserva campos não passados (mesma semântica de `upsert_lead_timeline`/`upsert_broker_profile`). `alertas` aceita array de strings — cada item vira `- ...` na seção `## Alertas`. Reafirmação §1.1: campos textuais; números detalhados ficam no sistema financeiro oficial. |
| `read_financial_series` | `as_agent, periods?, since?, until?, limit?=12, order?='desc'` | `{snapshots: [{period, frontmatter, caixa, receita, despesa, alertas, contexto}], next_cursor?}` | readOnly. Retorna série de snapshots parseados conforme body convention §5.9. Modos de seleção: (a) `periods` array explícito (`['2026-04','2026-03','2026-02']`) — ausentes geram `SNAPSHOT_NOT_FOUND` (sinaliza expectativa); (b) `since`/`until` (filtro por `period` lexicográfico, **não** por `mtime` — coerência com semântica do snapshot que é "fechamento do período") — ausentes no range são silenciosamente omitidos; (c) ambos coexistem (`periods` aplicado primeiro, `since/until` filtra). `limit` default 12 (1 ano). `order='desc'` (mais recente primeiro) é o default operacional pra "comparar com últimos N meses". |
| `read_agent_context` | `agent, n_decisions?=5, n_journals?=5` | `{profile, decisions, journals, goals, results}` | readOnly. Bundle único = contexto completo |
| `get_agent_delta` | `agent, since (ISO-8601 datetime), types?, include_content?=false` | `{decisions, journals, goals, results, shared_contexts, entity_profiles, other}` — cada grupo é `[{path, updated, mtime, frontmatter, preview}]`; `preview` ≤500 bytes; `content` full só quando `include_content=true`. `other` captura arquivos do agente que não caem nos 6 grupos específicos (ex.: `_agents/<agent>/README.md`, `_agents/<agent>/profile.md`, notas raiz que o agente possui). | readOnly. Filtro linear no índice por `owner == agent && mtime > since && (types === undefined \|\| type ∈ types)`. Escopo: tudo que `agent` é `owner` (inclui `_agents/<agent>/**`, `_shared/goals/*/<agent>.md`, `_shared/results/*/<agent>.md`, `_shared/context/*/<agent>/**`). Deleções NÃO entram no delta — consumir `audit.log` se precisar. **Para shared-context cross-agent (escrito por OUTROS agentes), usar `get_shared_context_delta`.** |
| `get_shared_context_delta` | `since (ISO-8601 datetime), topics?, owners?, include_content?=false` | `{by_topic: {<topic>: [{path, owner, updated, mtime, frontmatter, preview}]}, total: <int>}` — agrupado por `topic` (segmento do path `_shared/context/<topic>/<agent>/<slug>.md`); `preview` ≤500 bytes; `content` full só quando `include_content=true` | readOnly. Filtro linear no índice por `type == 'shared-context' && mtime > since && (topics === undefined \|\| topic ∈ topics) && (owners === undefined \|\| owner ∈ owners)`. Diferente de `get_agent_delta` (agent-scoped, retorna o que o **próprio** agente escreveu): este retorna shared-context escritos por **qualquer** agente. Caso de uso primário: heartbeat do Follow-up perguntando "o que a equipe aprendeu coletivamente desde minha última rodada?". Filtro `topics?` casa diretamente com a taxonomia canônica de §5.8 (ex.: `topics: ['opt-out','objecoes']`). |
| `get_training_target_delta` | `target_agent, since (ISO-8601 datetime), topics?, include_content?=false` | `{target_agent_delta: {decisions, journals, goals, results, shared_contexts, entity_profiles, other}, shared_about_target: [{path, owner, topic, mtime, frontmatter, preview}], regressions: [{path, owner, mtime, frontmatter, preview, status, severidade, categoria}], total: <int>}` — `target_agent_delta` é exatamente o retorno de `get_agent_delta(target_agent, since, types?)`; `shared_about_target` lista shared-contexts (de outros owners) que mencionam o alvo via tag `#alvo-<target_agent>` ou `Agente alvo: <target_agent>` no body; `regressions` é subset de `shared_about_target` filtrado a `topic == 'regressoes'`, separado em campo dedicado para destaque + parse adicional dos campos do body convention §5.8 (`status`, `severidade`, `categoria`) | readOnly. Compõe internamente 2-3 chamadas + parsing. Caso de uso primário: Sparring rodando "o que mudou sobre o Reno desde minha última bateria?". `total` = soma de itens nos 3 buckets (sem dedup; um arquivo em `regressoes/` com `#alvo-reno` aparece em ambos `shared_about_target` E `regressions` — `regressions` é projeção, não exclusão). |
| `upsert_shared_context` | `as_agent, topic, slug, title, content, tags?` | `{path, created_or_updated, sha?}` | MCP monta `_shared/context/<topic>/<as_agent>/<slug>.md`. `topic` e `slug` validados como kebab single-segment. Frontmatter auto-gerado com `type: shared-context`, `owner: as_agent`. Update livre pelo owner; cross-agent bloqueado via path ownership. |
| `upsert_entity_profile` | `as_agent, entity_type, entity_name, content, tags?, status?` | `{path, created_or_updated, sha?}` | MCP monta `_agents/<as_agent>/<entity_type>/<slug>.md`. `entity_type` validado como kebab single-segment (vocabulário livre). `slug` = ASCII-fold + kebab-case de `entity_name`. Frontmatter auto-gerado com `type: entity-profile`, `entity_type`, `entity_name`, `status?`. |
| `upsert_lead_timeline` | `as_agent, lead_name, resumo?, interesse_atual?, objecoes_ativas?, proximo_passo?, status_comercial?, origem?, tags?` | `{path, created_or_updated, sha?}` | Cria/atualiza `_agents/<as_agent>/lead/<slug>.md` com a estrutura padrão de 5 seções (§5.5). Slug = ASCII-fold + kebab de `lead_name`. Frontmatter `type: entity-profile`, `entity_type: lead`, `entity_name: lead_name` + campos lead-específicos. Update **preserva** a seção `## Histórico de interações` (não sobrescreve as interações existentes); só atualiza header sections (`## Resumo`, `## Interesse atual`, `## Objeções ativas`, `## Próximo passo`) com base nos params recebidos. Campos não passados em update mantêm valor anterior. |
| `append_lead_interaction` | `as_agent, lead_name, channel, summary, origem?, objection?, next_step?, tags?, timestamp?` | `{path, bytes_appended, block_inserted_at}` | Anexa bloco de interação no fim da seção `## Histórico de interações` do doc do lead `_agents/<as_agent>/lead/<slug>.md`. Cria a seção se ausente. `timestamp` default = `now()` em ISO-8601, formatado como `YYYY-MM-DD HH:MM` no header do bloco. Tags entram como linha `Tags: #tag1 #tag2` no fim do bloco. Falha com `LEAD_NOT_FOUND` se o doc do lead não existir — agente deve rodar `upsert_lead_timeline` primeiro. Formato fixo do bloco em §5.5. |
| `read_lead_history` | `as_agent, lead_name, since?, limit?, order?='desc'` | `{lead: {entity_name, status_comercial, origem, interesse_atual, objecoes_ativas, proximo_passo, ...frontmatter}, interactions: [{timestamp, channel, origem, summary, objection, next_step, tags}], next_cursor?}` | readOnly. Lê `_agents/<as_agent>/lead/<slug>.md`, parseia o frontmatter + as 4 header sections como `lead`, e os blocos da seção `## Histórico de interações` como `interactions`. `since` filtra por timestamp ISO-8601; `order='desc'` (default) = mais recente primeiro; `'asc'` = ordem cronológica de leitura. Blocos malformados emitem `MALFORMED_LEAD_BODY` warning e ficam fora do retorno (lista deles vai no log). |
| `upsert_broker_profile` | `as_agent, broker_name, comunicacao_estilo?, equipe?, nivel_engajamento?, dificuldades_recorrentes?, padroes_atendimento?, pendencias_abertas?, contato_email?, contato_whatsapp?, nivel_atencao?, ultima_acao_recomendada?, tags?` | `{path, created_or_updated, sha?}` | Cria/atualiza `_agents/<as_agent>/broker/<slug>.md` com a estrutura padrão de 5 seções (§5.6). Slug = ASCII-fold + kebab de `broker_name`. Frontmatter `type: entity-profile`, `entity_type: broker`, `entity_name: broker_name` + campos broker-específicos (incluindo `nivel_atencao?` e `ultima_acao_recomendada?` — vocabulário e regras em §5.6). Update **preserva** a seção `## Histórico de interações` (não sobrescreve interações); só atualiza header sections (`## Resumo`, `## Comunicação`, `## Padrões de atendimento`, `## Pendências abertas`) com base nos params recebidos. Campos não passados em update mantêm valor anterior. `ultima_acao_recomendada` rejeitado com `INVALID_FRONTMATTER` se contiver `\n`. |
| `append_broker_interaction` | `as_agent, broker_name, channel, summary, contexto_lead?, dificuldade?, encaminhamento?, tags?, timestamp?` | `{path, bytes_appended, block_inserted_at}` | Anexa bloco de interação no fim da seção `## Histórico de interações` do doc do broker `_agents/<as_agent>/broker/<slug>.md`. Cria a seção se ausente. `timestamp` default = `now()` em ISO-8601, formatado `YYYY-MM-DD HH:MM` no header. `contexto_lead?` opcional ancora a interação a um lead específico (slug do lead) sem aglutinar contextos. Tags entram como `Tags: #...`. Falha com `BROKER_NOT_FOUND` se doc inexistente. Formato fixo do bloco em §5.6. |
| `read_broker_history` | `as_agent, broker_name, since?, limit?, order?='desc'` | `{broker: {entity_name, equipe, nivel_engajamento, comunicacao_estilo, contato_email, contato_whatsapp, dificuldades_recorrentes, padroes_atendimento, pendencias_abertas, ...frontmatter}, interactions: [{timestamp, channel, contexto_lead, summary, dificuldade, encaminhamento, tags}], next_cursor?}` | readOnly. Lê `_agents/<as_agent>/broker/<slug>.md`. **Sempre escopado a UM `broker_name`** — não há tool de aggregation cross-broker (ver §5.7). Demais semânticas idênticas a `read_lead_history`. Blocos malformados emitem `MALFORMED_BROKER_BODY` warning. |
| `get_broker_operational_summary` | `as_agent, broker_name, n_recent_interactions?=5, periodo_tendencia_dias?=28` | `{broker: {entity_name, equipe, nivel_atencao, ultima_acao_recomendada, comunicacao_estilo, ...frontmatter}, pendencias_abertas: [...], dificuldades_recorrentes: [...], recent_interactions: [{timestamp, channel, summary, dificuldade, encaminhamento, contexto_lead}], dias_desde_ultima_interacao: <int \| null>, total_interacoes_periodo_atual: <int>, total_interacoes_periodo_anterior: <int>, dificuldades_repetidas: [{dificuldade, count}], sinais_de_risco: [<string>]}` | readOnly. Compõe internamente `read_broker_history` + parsing/contagem. `dias_desde_ultima_interacao = null` se zero interações; senão `now() - last_interaction.timestamp` em dias inteiros. `total_interacoes_periodo_atual` = contagem nos últimos `periodo_tendencia_dias`; `total_interacoes_periodo_anterior` = contagem entre `periodo_tendencia_dias` e `2 × periodo_tendencia_dias` atrás (permite agente computar tendência sem MCP opinionado). `dificuldades_repetidas` = count de strings idênticas no campo `Dificuldade:` dos blocos da janela atual; entradas com `count ≥ 2`. `sinais_de_risco` = lista de strings descritivas geradas pelo MCP a partir dos fatos (ex.: `"sem interação há 12 dias"`, `"3 pendências abertas"`, `"dificuldade 'objeção entrada' apareceu 4x em 28 dias"`, `"queda de 60% em interações vs período anterior"`). Não há "score" composto — fatos descritivos, agente interpreta. `BROKER_NOT_FOUND` se doc inexistente. |
| `list_brokers_needing_attention` | `as_agent, since?='7d', risk_levels?=['atencao','risco','critico'], equipes?, min_pendencias?, min_dificuldades_repetidas?, limit?=20, order?='priority'` | `{brokers: [{broker_name, nivel_atencao, equipe, dias_desde_ultima_interacao, pendencias_count, dificuldades_repetidas_count, ultima_acao_recomendada, priority_score}], total: <int>, next_cursor?}` | readOnly. Compõe `list_folder('_agents/<as_agent>/broker/')` + `read_note` em cada para extrair frontmatter + parsing rápido do histórico recente (janela = `since`). **Filtros aplicados em AND:** (a) `since?` = inatividade mínima em formato relativo (`'7d'`/`'30d'`/`'1w'`/`'2m'`/`'1y'` — regex `^\d+[dwmy]$`) **ou** ISO-8601 datetime; default `'7d'`. (b) `risk_levels?` filtra `nivel_atencao` (default exclui `normal`); (c) `equipes?` filtra `equipe`; (d) `min_pendencias?` filtra contagem de `pendencias_abertas`; (e) `min_dificuldades_repetidas?` filtra count na janela recente. **`order='priority'` (default)** usa `priority_score` desc — fórmula fixa: `priority_score = dias_desde_ultima_interacao + (pendencias_count × 3) + (dificuldades_repetidas_count × 2) + nivel_atencao_weight`, onde `nivel_atencao_weight = {normal: 0, atencao: 5, risco: 15, critico: 30}`. **`order='alphabetical'`** lista estável por `broker_name`. **`order='last_interaction'`** ordena por `dias_desde_ultima_interacao` desc (mais parado primeiro). `since?` inválido → `INVALID_RELATIVE_TIME`. Performance: para vault < 200 brokers escaneia tudo; acima disso ver upgrade path §11. |
| `search_by_tag` | `tag, owner?, since?, until?` | `{notes: [{path, type, owner, mtime}]}` | readOnly, índice. `owner` = `string \| string[]`. `since?`/`until?` = ISO-8601 (filtra por `mtime`); `INVALID_TIME_RANGE` se inválido |
| `search_by_type` | `type, owner?, since?, until?` | Igual | readOnly, índice. `owner` = `string \| string[]`. `since?`/`until?` mesma semântica |
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

- `readOnlyHint: true` em todas as tools de leitura (inclui `get_agent_delta`, `get_shared_context_delta`, `get_training_target_delta`, `read_lead_history`, `read_broker_history`, `read_financial_series`, `get_broker_operational_summary`, `list_brokers_needing_attention`).
- `destructiveHint: true` em `delete_note`.
- `idempotentHint: true` em `upsert_*` (inclui `upsert_shared_context`, `upsert_entity_profile`, `upsert_lead_timeline`, `upsert_broker_profile`, `upsert_financial_snapshot`), `update_agent_profile`, `get_note_metadata`. **Não** em `append_lead_interaction` nem `append_broker_interaction` (cada chamada cria um bloco novo no histórico, não é idempotente).
- `openWorldHint: false` (vault é fechado).

## 5. Validação

### 5.1 Frontmatter — Base schema

**Regra universal:** todo arquivo `.md` do vault tem frontmatter YAML obrigatório. Escritas sem frontmatter, ou com campos base ausentes, retornam `INVALID_FRONTMATTER`. Leituras de arquivos legados sem frontmatter retornam o conteúdo com `frontmatter: null` + warning no log para remediação manual.

**Exceções documentadas** (arquivos fora do vault gerenciado pelo MCP, mantidos sem frontmatter intencionalmente):
- `/CLAUDE.md` — instruções de projeto para Claude Code, consumido pelo harness, não pelo vault.
- `/_infra/README.md` — documentação operacional de sync/deploy, não faz parte do conhecimento dos agentes.

O MCP trata esses paths como leitura livre (retorna conteúdo cru) e bloqueia escrita via `UNMAPPED_PATH` (ver §5.4) — mudanças nesses arquivos seguem fluxo git normal, fora da API do MCP.

```ts
BaseFrontmatter = {
  type: enum('moc','context','agents-map','goal','goals-index',
             'result','results-index','agent-readme','agent-profile',
             'agent-decisions','journal','project-readme',
             'shared-context','entity-profile','financial-snapshot'),
  owner: string,              // validado contra ownership map
  created: YYYY-MM-DD,        // preservado em updates
  updated: YYYY-MM-DD,        // auto-atualizado em toda escrita
  tags: string[]              // kebab-case, flat
}
```

Extensões por `type` via discriminated union:
- `journal`: **frontmatter YAML obrigatório** como qualquer outro tipo (o vault atual tem journals vazios; a partir do MCP toda nova entrada nasce com frontmatter). `title` opcional, coerente com o filename.
- `goal` / `result`: `period: YYYY-MM` obrigatório. O MCP **injeta `period` automaticamente** em toda escrita de `goal`/`result`, derivando-o do path (`_shared/goals/<period>/<agent>.md`). Agentes não precisam informá-lo; se o campo chegar no payload e divergir do path, o MCP corrige para o valor do path e registra warning.
- `shared-context`: `topic: string` (kebab, single-segment) **e** `title: string` obrigatórios. `topic` é derivado do path (`_shared/context/<topic>/<agent>/<slug>.md`) e injetado pelo MCP; divergência entre payload e path vira warning e o path vence. Tipo reservado para escritas via `upsert_shared_context` — separa a zona curada inter-agente dos arquivos canônicos (`type: context`, usados em `FAMA.md`, `fama/*`, `AGENTS.md`).
- `entity-profile`: `entity_type: string` (kebab, single-segment) **e** `entity_name: string` obrigatórios; `status?: string` opcional. `entity_type` é derivado do path (`_agents/<agent>/<entity_type>/<slug>.md`) e injetado pelo MCP; divergência com payload vira warning e o path vence.
  - **Sub-branch `entity_type='lead'`** (lead-específico, addendum 2026-04-16): além dos campos base de `entity-profile`, aceita campos opcionais lead-comerciais — `status_comercial?: string`, `origem?: string`, `interesse_atual?: string`, `objecoes_ativas?: string[]`, `proximo_passo?: string`. `status_comercial` é o campo de status canônico do lead (mais específico que o `status?` genérico do `entity-profile`); ambos podem coexistir mas o vocabulário de leads opera em `status_comercial`. Body markdown segue convenção §5.5.
  - **Sub-branch `entity_type='broker'`** (broker-específico, addendum FamaAgent 2026-04-16; estendido pelo addendum ceo-exec 2026-04-16): além dos campos base de `entity-profile`, aceita campos opcionais broker-operacionais — `equipe?: string`, `nivel_engajamento?: string` (vocabulário recomendado: `ativo`, `em-treinamento`, `inativo`, `desligado` — não enforced), `comunicacao_estilo?: string`, `contato_email?: string`, `contato_whatsapp?: string`, `dificuldades_recorrentes?: string[]`, `padroes_atendimento?: string`, `pendencias_abertas?: string[]`, **`nivel_atencao?: string`** (vocabulário canônico em §5.6: `normal`/`atencao`/`risco`/`critico` — não enforced para permitir evolução), **`ultima_acao_recomendada?: string`** (uma linha; rejeitado com `INVALID_FRONTMATTER` se contiver `\n`, mesma regra dos `*_resumo` do financial-snapshot). Body markdown segue convenção §5.6. Importante (governance §1.1): campos de contato no frontmatter são para **operação do agente** (saber por onde alcançar o broker), não para virar diretório oficial — dados oficiais de contato vivem em RH/CRM. Distinção `nivel_engajamento` vs `nivel_atencao`: `nivel_engajamento` descreve o **estado do broker em relação à empresa** (ativo, em-treinamento, etc — RH/HR-side); `nivel_atencao` descreve **prioridade operacional do agente** sobre esse broker (precisa de intervenção?). Os dois coexistem.
- `financial-snapshot` (per-período, parallel a `goal`/`result` — addendum cfo-exec 2026-04-16): `period: 'YYYY-MM'` obrigatório (injetado pelo path `_shared/financials/<period>/<agent>.md`, mesma mecânica de goal/result; divergência payload↔path → path vence + warning). Campos opcionais `caixa_resumo?: string`, `receita_resumo?: string`, `despesa_resumo?: string` (uma linha cada, **texto** não-numérico — auto-extraídos da primeira linha não-vazia da seção do body se ausentes), `alertas_count?: number` (auto-calculado da contagem do array `alertas` recebido pelo `upsert_financial_snapshot`). Body markdown segue convenção §5.9. Importante (governance §1.1): tipo é **resumo operacional** — números detalhados, contas a pagar/receber, transações ficam no sistema financeiro oficial; campos `*_resumo` são intencionalmente texto curto, não numéricos.
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
3. **Validação:** `resolveOwner(path)` → `agent | null`.
   - Se `owner` definido e `as_agent !== owner`: `OWNERSHIP_VIOLATION`.
   - Se `owner === null` (path fora de qualquer pattern): **escrita bloqueada com `UNMAPPED_PATH`**. Mensagem: `Path '<path>' não está mapeado em _shared/context/AGENTS.md. Adicione um pattern antes de escrever aqui.` Força explicitude — nunca há dono implícito/fallback. Leitura permanece livre.

**AGENTS.md deve cobrir todos os paths que recebem escrita**, incluindo edge cases: `_shared/goals/*/index.md`, `_shared/results/*/index.md`, `_projects/**`, `_infra/**`, raiz (`README.md`, `MEMORY.md`, etc). Os dois arquivos fora do vault gerenciado (§5.1) não precisam de mapping — escrita neles é bloqueada por `UNMAPPED_PATH` intencionalmente.

**Patterns adicionais exigidos pelas tools novas (addendum 2026-04-16):**
- `_shared/context/*/<agent>/**` → `<agent>` para cada agente habilitado a escrever contexto curado via `upsert_shared_context`. Wildcard do meio (`*` = topic) exige glob lib com suporte a múltiplos segmentos (minimatch ou equivalente).
- `_agents/<agent>/<entity_type>/**` já está coberto pelo pattern existente `_agents/<agent>/**` — `upsert_entity_profile` não requer entrada nova em `AGENTS.md`.
- `_shared/financials/*/<agent>.md` → `<agent>` para cada agente habilitado a escrever snapshots financeiros (cfo-exec, ceo-exec, cfo, ceo, etc.). Mesmo padrão de wildcard do meio dos goals/results. Nova top-level dir `_shared/financials/`.

Erro exemplar:
> `File '_agents/ceo/decisions.md' is owned by 'ceo', not 'cto'. Use as_agent='ceo' ou escreva em _agents/cto/.`

### 5.5 Padrão lead (entity_type=lead)

**Status:** convenção first-class para o agente Reno (OpenClaw). Documentada aqui porque as 3 tools `upsert_lead_timeline` / `append_lead_interaction` / `read_lead_history` impõem essa estrutura ao escrever e dependem dela ao ler.

**Path canônico:** `_agents/<agent>/lead/<slug>.md` (singular `lead`, kebab-case slug derivado de `entity_name` por ASCII-fold + kebab).

**Body markdown — 5 seções na ordem:**

```markdown
## Resumo
<texto livre — quem é o lead, contexto sintético>

## Interesse atual
<texto livre — o que o lead quer agora>

## Objeções ativas
- <objeção 1>
- <objeção 2>

## Próximo passo
<texto livre — ação seguinte do Reno>

## Histórico de interações

## YYYY-MM-DD HH:MM
Canal: <whatsapp|telefone|email|presencial|...>
Origem: <campanha/origem do contato>
Resumo: <o que aconteceu nessa interação>
Objeção: <objeção surgida — opcional>
Próximo passo: <combinado nessa interação — opcional>
Tags: #tag1 #tag2

## YYYY-MM-DD HH:MM
...
```

**Regras de escrita:**

- `upsert_lead_timeline` reescreve as 4 seções de header (`## Resumo`, `## Interesse atual`, `## Objeções ativas`, `## Próximo passo`) com base nos params recebidos. Campos não passados em update mantêm valor anterior. **Nunca** toca em `## Histórico de interações`.
- `append_lead_interaction` insere bloco novo no fim da seção `## Histórico de interações`. Se a seção não existe (lead criado por `upsert_lead_timeline` antes da primeira interação), a tool cria a seção antes de inserir. **Sempre append no fim** (mais antigo no topo, mais recente no fim) — diferente de `decisions.md`. A escolha é deliberada: histórico de lead é uma narrativa que se lê do começo, não um stack de decisões.
- Bloco de interação é **append-only**: `read_lead_history` parseia mas não há tool para editar/deletar interações individuais. Correções viram nova interação (`Resumo: correção da interação anterior — ...`). Limpeza profunda exige `write_note` direto com `as_agent=<agent>` e justificativa em commit message.

**Regras de leitura:**

- O cabeçalho `## Histórico de interações` é o **delimitador canônico** entre as 4 header sections (acima) e os blocos de interação (abaixo). O parser lê tudo que vem antes desse delimitador como header sections (parse por nome literal: `## Resumo`, `## Interesse atual`, `## Objeções ativas`, `## Próximo passo`); tudo que vem depois é candidato a bloco de interação.
- `read_lead_history` parseia blocos por regex `^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})$` seguido de linhas `Chave: valor`. Bloco que não casa o regex emite warning `MALFORMED_LEAD_BODY` e fica fora do retorno.
- O parse das header sections é por nome literal de cabeçalho. Header section ausente vira `null` no retorno (não bloqueia leitura — lead pode ter sido criado parcialmente).
- Se o delimitador `## Histórico de interações` estiver ausente, o parser assume "lead sem histórico ainda" — `interactions: []`, header sections continuam sendo parseadas normalmente.

**Validação no upsert:**

- `lead_name` obrigatório, máximo 100 caracteres.
- `objecoes_ativas`, se passado, deve ser array de strings (cada objeção vira um item `- ...` na seção).
- `status_comercial` é string livre (vocabulário recomendado: `qualificando`, `proposta`, `negociando`, `fechado`, `perdido`, `em-pausa` — não enforced para permitir evolução do funil sem mudança de spec).

### 5.6 Padrão broker (entity_type=broker)

**Status:** convenção first-class para o agente FamaAgent (OpenClaw). Espelha §5.5 (lead) na mecânica — header sections + blocos de interação delimitados por `## Histórico de interações` — mas com vocabulário e campos próprios do contexto operacional do corretor.

**Path canônico:** `_agents/<agent>/broker/<slug>.md` (singular `broker`, kebab-case slug derivado de `entity_name` por ASCII-fold + kebab).

**Body markdown — 5 seções na ordem:**

```markdown
## Resumo
<texto livre — quem é o corretor, contexto sintético: tempo de casa, regional, perfil>

## Comunicação
<texto livre — estilo de comunicação preferido, horários, canais que funcionam, tom>

## Padrões de atendimento
<texto livre — como esse corretor costuma atender, fortes/fracos, padrões observados>

## Pendências abertas
- <pendência 1 — ex.: aguardando resposta sobre lead João Silva>
- <pendência 2>

## Histórico de interações

## YYYY-MM-DD HH:MM
Canal: <whatsapp|telefone|telegram|presencial|...>
Lead em contexto: <slug-do-lead-ou-vazio>
Resumo: <o que aconteceu nessa interação>
Dificuldade: <opcional — dificuldade que o corretor relatou>
Encaminhamento: <opcional — combinado nessa interação>
Tags: #tag1 #tag2

## YYYY-MM-DD HH:MM
...
```

**Regras de escrita, leitura e validação:** idênticas em mecânica às de §5.5 (lead), substituindo:

- `upsert_lead_timeline` → `upsert_broker_profile`
- `append_lead_interaction` → `append_broker_interaction`
- `read_lead_history` → `read_broker_history`
- 4 header sections do lead → 4 header sections do broker (`## Resumo`, `## Comunicação`, `## Padrões de atendimento`, `## Pendências abertas`)
- Bloco de interação adapta os campos: `Lead em contexto`, `Dificuldade`, `Encaminhamento` substituem `Origem`, `Objeção`, `Próximo passo` do lead.
- Erro `LEAD_NOT_FOUND` → `BROKER_NOT_FOUND`; warning `MALFORMED_LEAD_BODY` → `MALFORMED_BROKER_BODY`.
- Validações: `broker_name` obrigatório, máximo 100 caracteres; `pendencias_abertas` e `dificuldades_recorrentes`, se passados, são arrays de strings; `nivel_engajamento` é string livre (vocabulário recomendado em §5.1).

**Campos executivos (extensão addendum ceo-exec 2026-04-16):**

- **`nivel_atencao`** — vocabulário canônico:
  - `normal` — corretor operando bem, sem sinais de risco. Default implícito quando o campo não é informado.
  - `atencao` — leve sinal (ex.: 1-2 dias de inatividade incomum, dificuldade nova reportada).
  - `risco` — sinais consolidados (ex.: 7+ dias inatividade, múltiplas pendências, dificuldade recorrente).
  - `critico` — intervenção urgente necessária (silêncio prolongado, abandono, conflito reportado).

  Mudança de `nivel_atencao` é sempre **decisão explícita** do agente via `upsert_broker_profile` — não há auto-detect baseado em heurísticas (evita falsos positivos que minariam confiança no campo). `get_broker_operational_summary` retorna `sinais_de_risco` descritivos para informar a decisão do agente, mas não muda o nível.

- **`ultima_acao_recomendada`** — formato livre, mas convenção é uma linha com **verbo + complemento** (ex.: `"ligar para alinhar pendência sobre lead João Silva"`, `"agendar 1:1 sobre objeções recorrentes de entrada"`, `"aguardar retorno do broker até quinta"`). Atualizada a cada `upsert_broker_profile` quando o agente formar nova recomendação. Útil em listagens executivas (`list_brokers_needing_attention` retorna esse campo direto, sem o agente precisar abrir cada broker).

**Distinção lead vs broker no design:** `lead` = pessoa em processo de aquisição (cliente/prospect imobiliário); `broker` = corretor da Fama. Os papéis dos agentes diferem:

- **Reno (OpenClaw)** atende leads diretamente — usa só `_agents/reno/lead/**`.
- **FamaAgent (OpenClaw)** apoia brokers que atendem leads — usa tanto `_agents/famaagent/broker/**` quanto `_agents/famaagent/lead/**` (leads em que o FamaAgent participa diretamente do atendimento, ou leads cujo contexto precisa estar acessível independentemente do broker).

Os dois entity_types coexistem sob qualquer agente sem se misturar (paths distintos `lead/` vs `broker/`). O campo `Lead em contexto` na interação do broker é a única ponte explícita entre os dois — ancora uma interação broker a um lead específico sem aglutinar contextos (o broker.md não absorve o histórico do lead, só referencia).

### 5.7 Convenção de isolamento por broker

**Motivação:** FamaAgent atende múltiplos corretores em sessões curtas. Risco operacional principal: misturar contexto do corretor A no atendimento do corretor B dentro do mesmo agent owner. Ownership por `as_agent` resolve cross-agent (famaagent vs reno) mas não resolve intra-agent (broker A vs broker B sob o mesmo famaagent). A solução é convencional + tool design — não session state técnico no MCP (que é stateless por escolha).

**Regras:**

1. **Tools `*_broker_*` operam sobre UM broker por chamada.** `read_broker_history(broker_name='A')` retorna apenas A. `append_broker_interaction(broker_name='A', ...)` escreve apenas em A. Não existe `read_brokers_aggregate`, `search_across_brokers`, ou similar no MVP — ausência deliberada (§10), não esquecimento.

2. **Cross-broker aggregation legítima existe** (ex.: relatório mensal de pendências de todos os corretores), mas o agente deve compor explicitamente: `list_folder('_agents/famaagent/broker/')` retorna a lista; depois N chamadas a `read_broker_history` ou `read_note`. Forçar essa composição faz o agente ser deliberado sobre cross-broker em vez de fazer por acidente durante o atendimento de um.

3. **Filtro `path` em `search_*` é a forma recomendada para queries operacionais durante atendimento.** Ao atender broker `<slug>`, queries devem usar `path: '_agents/famaagent/broker/<slug>/'` para garantir que resultados não vazem de outros brokers. O MCP **não** enforça isso — é responsabilidade do caller.

4. **Anti-pattern documentado:** ao atender o broker A, **não** chame `read_broker_history(broker_name='B')` no mesmo turno de raciocínio. A disciplina de isolamento é responsabilidade do caller (agente). O MCP fornece tools naturalmente scoped; o uso correto é convenção.

5. **Auditoria:** os audit logs (§6.3) registram `as_agent`, `tool`, `path` em toda escrita. Auditoria post-hoc de "quais brokers o famaagent tocou em sessões da semana passada" é viável via grep no `audit.log`.

**O que NÃO está incluso (decisão deliberada):**

- ❌ Session scope técnico ("famaagent está atendendo broker A agora") — adiciona estado a um MCP stateless; client-side em vez de server-side.
- ❌ ACL intra-agent (broker A não vê dados de B mesmo se famaagent chamar) — vira sistema de permissões dentro do owner do agente; complexidade injustificada para o caso de uso.
- ❌ Validação automática de "isso parece dado de outro broker" — falsos positivos tornariam unusable.

### 5.8 Taxonomia canônica de `_shared/context/` (Follow-up)

**Status:** convenção operacional para todos os agentes que escrevem em `_shared/context/`. Documentada para reduzir o risco de "múltiplas versões da verdade operacional" levantado pelo Follow-up — pequenas divergências na forma como agentes registram opt-out, objeções ou abordagens podem gerar erros caros (ex.: reabordar um lead que já fez opt-out porque o sinal foi gravado em um tópico não-padrão).

**6 tópicos canônicos:**

| Topic (path segment) | Semântica | Quem normalmente escreve | Exemplos de slug |
|---|---|---|---|
| `opt-out` | Sinais de opt-out por canal/tipo, abordagens explicitamente proibidas, severidade do bloqueio | Follow-up, Reno, FamaAgent | `whatsapp-bloco-explicito.md`, `silencio-pos-3-tentativas.md`, `pediu-pausa-30d.md` |
| `objecoes` | Objeções recorrentes de lead/cliente, padrões de resposta, evidência de campo | Reno, Follow-up, Sparring, FamaAgent | `entrada-alta.md`, `medo-da-parcela.md`, `documentacao-cef.md` |
| `retomadas` | Padrões de reaproximação de lead frio, abordagens de retomada por estágio | Follow-up | `frio-30-dias.md`, `interesse-baixo-pos-visita.md`, `silencio-2-semanas.md` |
| `aprendizados` | Aprendizados por campanha, estágio do funil, tipo de empreendimento, perfil de público | Qualquer agente operacional (Reno, Follow-up, FamaAgent, Sparring) | `union-vista-trafego-pago.md`, `pre-lancamento-conversao.md`, `publico-cef-baixa-renda.md` |
| `abordagens` | Abordagens (scripts/templates) que funcionam ou queimam, registro com evidência | Follow-up, Reno, FamaAgent | `abertura-curta-frio.md`, `pergunta-aberta-quente.md`, `cta-direto-queima.md` |
| `regressoes` | Regressões observadas no comportamento de outros agentes (especialmente Reno alvo do Sparring); achados de bateria de teste; padrões de erro recorrentes; rastreio de status (aberto, corrigido, etc.) | Sparring (principal), eventualmente outros agentes que detectarem regressão própria ou de pares | `reno-tom-frio-em-objecao.md`, `followup-timing-pos-opt-out.md`, `famaagent-vazamento-broker.md` |

**Regras:**

1. **Tópicos canônicos têm semântica fixa** — usar o tópico errado para o conteúdo é considerado violação de convenção. Ex.: registrar uma objeção em `aprendizados/` em vez de `objecoes/` quebra a buscabilidade por outros agentes.

2. **Tópicos novos são permitidos** mas a spec recomenda primeiro tentar encaixar nos canônicos. `upsert_shared_context` valida `topic` apenas como kebab single-segment (não restringe à lista) — flexibilidade deliberada para evolução. Quando um tópico não-canônico se firmar (3+ usos consistentes por agentes diferentes), promover a canônico via revisão da spec.

3. **Tags recomendadas** dentro dos tópicos (não enforced, mas usadas por convenção):
   - `#canal-whatsapp`, `#canal-telefone`, `#canal-email`, `#canal-presencial` — canal de comunicação relevante
   - `#stage-frio`, `#stage-morno`, `#stage-quente`, `#stage-pos-visita`, `#stage-pos-proposta` — estágio do funil
   - `#empreendimento-<slug>` — vínculo a empreendimento específico (ex.: `#empreendimento-union-vista`)

4. **Tags canônicas para `regressoes/`** (convenção mais rigorosa; não enforced tecnicamente, mas sem elas as queries estruturadas do Sparring tipo "regressões abertas de severidade alta no Reno" ficam impossíveis):
   - **Status:** `#regressao-aberta`, `#regressao-em-investigacao`, `#regressao-corrigida`, `#regressao-wontfix`
   - **Severidade:** `#severidade-alta`, `#severidade-media`, `#severidade-baixa`
   - **Categoria do erro:** `#categoria-tom`, `#categoria-timing`, `#categoria-objecao`, `#categoria-dados`, `#categoria-contexto`, `#categoria-outro`
   - **Agente alvo:** `#alvo-reno`, `#alvo-followup`, `#alvo-famaagent`, `#alvo-sparring`, `#alvo-<agent>` — essencial para Sparring filtrar por quem foi treinado/observado; também usado por `get_training_target_delta` para projetar o subset `regressions` no retorno.

**Body convention para `opt-out/`** (caso especial dada criticidade — não enforced, mas fortemente recomendado):

```markdown
## Sinal
<descrição literal do sinal observado — ex.: "cliente pediu pra parar de mandar mensagem por WhatsApp">

## Canal afetado
<whatsapp | telefone | email | todos>

## Severidade
<bloqueante | temporaria | atencao>

## Ação recomendada
<o que outros agentes devem fazer ao encontrar esse lead — ex.: "não retomar nunca por WhatsApp; só telefone se justificadamente solicitado pelo lead">
```

**Vocabulário canônico de severidade em `opt-out/`:**

- **`bloqueante`** — não retomar nunca, em nenhum canal. Equivalente operacional ao opt-out oficial (mas o registro oficial vive no sistema oficial, ver §1.1).
- **`temporaria`** — pausar por N dias (especificado no body); após, pode retomar com cautela.
- **`atencao`** — não bloqueia, mas sinaliza que o lead expressou desconforto; agentes devem moderar abordagem.

**Body convention para `regressoes/`** (caso especial dada criticidade e necessidade de query estruturada do Sparring — não enforced, fortemente recomendado):

```markdown
## Agente alvo
<reno | followup | famaagent | sparring | ceo | ...>

## Cenário
<descrição literal da situação testada — input, contexto, expectativa>

## Comportamento esperado
<o que deveria ter acontecido>

## Comportamento observado
<o que efetivamente aconteceu — com evidência se possível (transcript, log, screenshot reference)>

## Severidade
<alta | media | baixa>

## Status
<aberta | em-investigacao | corrigida | wontfix>

## Categoria
<tom | timing | objecao | dados | contexto | outro>

## Histórico
<opcional — log de retests, revisitas, mudanças de status com timestamps no formato YYYY-MM-DD HH:MM, mais antigo no topo>
```

**Vocabulário canônico em `regressoes/`** (replicação textual das tags da regra 4 acima, garantindo coerência body↔tags):

- **`Status`** body field ↔ `#regressao-<status>` tag — devem combinar (parser pode warning se divergirem).
- **`Severidade`** body field ↔ `#severidade-<nivel>` tag — devem combinar.
- **`Categoria`** body field ↔ `#categoria-<categoria>` tag — devem combinar.
- **`Agente alvo`** body field ↔ `#alvo-<agent>` tag — devem combinar.

A duplicação body↔tag é deliberada: tags habilitam queries no índice (`search_by_tag`); body habilita leitura humana no Obsidian e parsing estruturado por `get_training_target_delta`. Em caso de divergência, o **body é fonte de verdade** (parsing estruturado vence) e a tag desatualizada vira warning para correção manual.

**Como Follow-up consome:**

```
get_shared_context_delta(
  since='2026-04-09T00:00:00Z',
  topics=['opt-out','retomadas','abordagens']
) → { by_topic: { 'opt-out': [...], 'retomadas': [...], 'abordagens': [...] }, total: <int> }
```

Usado no início de cada heartbeat para alinhar com aprendizados/sinais coletivos da semana antes de disparar mensagens proativas.

**Como Sparring consome:**

```
get_training_target_delta(
  target_agent='reno',
  since='2026-04-09T00:00:00Z',
  topics=['regressoes','aprendizados','objecoes']
) → {
  target_agent_delta: { decisions: [...], journals: [...], ... },
  shared_about_target: [...],     // shared-contexts mencionando #alvo-reno (qualquer tópico)
  regressions: [...],              // subset filtrado a topic=regressoes, com status/severidade/categoria parseados
  total: <int>
}
```

Usado no início de cada bateria de teste para consolidar "o que mudou sobre o Reno desde minha última rodada" sem múltiplas chamadas + composição manual.

### 5.9 Padrão financial-snapshot (cfo-exec)

**Status:** convenção first-class para o agente cfo-exec (e demais agentes financeiros: ceo-exec, cfo, ceo). Tipo é parallel a `goal`/`result` na mecânica per-período (path com `<period>`, frontmatter com `period: 'YYYY-MM'` injetado), mas com body convention dedicado para suportar comparação cross-período de caixa/receita/despesa/alertas.

**Path canônico:** `_shared/financials/<period>/<agent>.md` (ex.: `_shared/financials/2026-04/cfo-exec.md`). Período é segmento intermediário (espelha `_shared/goals/`/`_shared/results/`); agente é o filename. Ownership por `_shared/financials/*/<agent>.md` (ver §5.4).

**Body markdown — 5 seções na ordem:**

```markdown
## Caixa
<resumo operacional — saldo confortável/apertado, fluxo previsto, posição relativa ao mês anterior. Texto curto, alguns parágrafos no máximo.>

## Receita
<resumo operacional — % vs meta, principais drivers do mês, comparação com período anterior. Texto narrativo.>

## Despesa
<resumo operacional — dentro/fora do orçado, principais variações, contexto. Texto narrativo.>

## Alertas
- <alerta 1 — ex.: "fluxo crítico em maio se 2 fechamentos previstos não saírem">
- <alerta 2 — ex.: "custo de aquisição estourou 12% em relação ao orçado">

## Contexto adicional
<notas livres do agente sobre o período — eventos não-recorrentes, decisões pendentes, observações qualitativas>
```

**Regras de escrita:**

- `upsert_financial_snapshot` cria/atualiza o doc do snapshot do período. Cada chamada com o mesmo `period` faz update — não há append (snapshot é uma fotografia do período, reescrita conforme o entendimento operacional evolui).
- Update preserva campos não passados (mesma semântica de `upsert_lead_timeline`). Caller que quer **limpar** uma seção passa string vazia (ou `[]` para `alertas`); ausência mantém valor anterior.
- **Auto-extração de campos `*_resumo`:** se `caixa_resumo`/`receita_resumo`/`despesa_resumo` não forem passados, MCP extrai automaticamente a primeira linha não-vazia da seção correspondente do body recebido (ou mantida do anterior). Se nem body nem campo explícito existem, fica `null` no frontmatter.
- **`alertas_count`:** sempre auto-calculado pela contagem do array `alertas` recebido (ou da contagem de itens `- ...` na seção `## Alertas` se preservado de update anterior). Caller não passa esse campo.

**Regras de leitura:**

- `read_financial_series` parseia as 5 seções literais por nome de cabeçalho (`## Caixa`, `## Receita`, `## Despesa`, `## Alertas`, `## Contexto adicional`). Seções ausentes viram `null` no retorno; ausência **não** bloqueia leitura — snapshot pode ter sido criado parcialmente.
- `## Alertas` é parseado como array de strings (cada item `- ...` vira elemento). Se a seção existir mas não tiver itens, retorna `[]`.
- Demais seções retornam string (texto markdown completo da seção, sem o cabeçalho).

**Validação no upsert:**

- `period` obrigatório, formato `YYYY-MM` exato (`INVALID_PERIOD` se diferente).
- `alertas`, se passado, deve ser array de strings.
- Campos `*_resumo`, se passados explicitamente, devem ser string de uma linha (sem `\n`); MCP rejeita com `INVALID_FRONTMATTER` se conter quebra de linha (forçar one-liner pra coerência com listagem).
- **Reafirmação governance §1.1:** o tipo é resumo operacional textual. MCP não valida nem incentiva valores numéricos detalhados nos campos `*_resumo`. Convenção: usar texto qualitativo ("dentro do orçado", "78% da meta", "fluxo confortável") em vez de "R$ 1.247.583,42" — esses números pertencem ao sistema financeiro oficial.

**Como cfo-exec consome (comparação cross-período):**

```
read_financial_series(
  as_agent='cfo-exec',
  since='2026-02',
  until='2026-04',
  order='desc'
) → {
  snapshots: [
    { period: '2026-04', frontmatter: {caixa_resumo: '...', receita_resumo: '...', alertas_count: 2, ...}, caixa: '...', receita: '...', despesa: '...', alertas: [...], contexto: '...' },
    { period: '2026-03', ... },
    { period: '2026-02', ... }
  ]
}
```

Usado no início de análises trimestrais ou quando o Renato pergunta tendências — agente compara as seções correspondentes mês-a-mês no próprio raciocínio (MCP não computa diffs).

## 6. Respostas e erros

### 6.1 Formato dual

Toda tool retorna:
- `content: [{ type: "text", text: <markdown preview> }]`
- `structuredContent: { ... }` — JSON consumível

### 6.2 Erros tipados

| Code | Retry? |
|---|---|
| `OWNERSHIP_VIOLATION` | não |
| `UNMAPPED_PATH` | não (requer update de `_shared/context/AGENTS.md`) |
| `INVALID_FRONTMATTER` | não (agente corrige) |
| `INVALID_FILENAME` | não |
| `INVALID_OWNER` | não (filtro de busca recebeu agente fora do ownership map; mensagem inclui lista de owners válidos) |
| `IMMUTABLE_TARGET` | não |
| `JOURNAL_IMMUTABLE` | não (agente usa `append_to_note`) |
| `NOTE_NOT_FOUND` | não |
| `LEAD_NOT_FOUND` | não (`append_lead_interaction`/`read_lead_history` em lead inexistente; mensagem sugere `upsert_lead_timeline` primeiro) |
| `BROKER_NOT_FOUND` | não (`append_broker_interaction`/`read_broker_history` em broker inexistente; mensagem sugere `upsert_broker_profile` primeiro) |
| `SNAPSHOT_NOT_FOUND` | não (`read_financial_series` chamado com `periods` array explícito contendo período sem snapshot escrito; sinaliza expectativa do agente vs. ausência silenciosa do modo `since/until`) |
| `INVALID_PERIOD` | não (formato de `period` em `upsert_financial_snapshot` ≠ `YYYY-MM`) |
| `INVALID_TIME_RANGE` | não (filtro temporal `since`/`until` com formato ISO-8601 inválido ou `since > until`) |
| `INVALID_RELATIVE_TIME` | não (`since?` em `list_brokers_needing_attention` não casa formato relativo `^\d+[dwmy]$` nem ISO-8601) |
| `WIKILINK_TARGET_MISSING` (warn) | — |
| `MALFORMED_LEAD_BODY` (warn) | — (bloco do histórico não casa formato §5.5; `read_lead_history` retorna o que conseguiu parsear + lista de blocos rejeitados) |
| `MALFORMED_BROKER_BODY` (warn) | — (bloco do histórico não casa formato §5.6; `read_broker_history` retorna o que conseguiu parsear + lista de blocos rejeitados) |
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
| `search_by_tag`, `get_backlinks`, `get_agent_delta`, `get_shared_context_delta` | < 50ms |
| `get_training_target_delta` (compõe internamente, parsing extra dos campos de regressão) | < 100ms |
| `read_lead_history`, `read_broker_history` (parse de até ~500 interações) | < 100ms |
| `read_financial_series` (parse de até 12 snapshots por chamada — default `limit`) | < 100ms |
| `get_broker_operational_summary` (compõe `read_broker_history` + parsing/contagem) | < 150ms |
| `list_brokers_needing_attention` (escaneia até 200 brokers; acima disso ver §11) | < 500ms |
| `search_content` (ripgrep) | < 500ms (vault < 10k notas); filtro temporal `since`/`until` reduz scope antes do ripgrep, devendo melhorar em queries com janela curta |
| Writes (sem push) — inclui `upsert_shared_context`, `upsert_entity_profile`, `upsert_lead_timeline`, `append_lead_interaction`, `upsert_broker_profile`, `append_broker_interaction`, `upsert_financial_snapshot` | < 100ms |
| `commit_and_push` | < 3s (dominado por rede) |
| Build inicial do índice (boot) | < 2s para vault atual |

## 8. Testes

### 8.1 Unitários (vitest)

- `frontmatter.ts`: parse/serialize round-trip; rejeição de schemas inválidos; preservação de campos extras; idempotência. Cobrir os 15 `type`s incluindo `shared-context` (requer `topic` + `title`), `entity-profile` (requer `entity_type` + `entity_name`), o sub-branch `entity_type=lead` (campos `status_comercial?`, `objecoes_ativas?` array, etc), o sub-branch `entity_type=broker` (campos `equipe?`, `nivel_engajamento?`, `pendencias_abertas?` array, contato fields), e `financial-snapshot` (requer `period: YYYY-MM`; campos opcionais `caixa_resumo?`/`receita_resumo?`/`despesa_resumo?` rejeitados se contiverem `\n`; `alertas_count` auto-calculado).
- `ownership.ts`: resolução por path/glob; reload on mtime change; mensagens. Cobrir pattern com wildcard do meio (`_shared/context/*/<agent>/**`).
- `fs.ts`: ASCII-fold idempotente; kebab-case validation; bloqueio de path traversal (`..`, symlinks suspeitos).
- `vault/index.ts`: build inicial; invalidação incremental pós-write; backlinks corretos para wikilinks múltiplos; `mtime` armazenado por nota e atualizado em cada write; filtros temporais (`since`/`until`) sobre o índice; `INVALID_TIME_RANGE` em entradas malformadas.
- `lead.ts` (parser/serializer dedicado): parse das 4 header sections + blocos de interação; round-trip preserva ordem; bloco malformado emite `MALFORMED_LEAD_BODY` sem quebrar parse dos blocos válidos; serialização de `objecoes_ativas` (array de strings) vira lista markdown `- ...` correta.
- `broker.ts` (parser/serializer dedicado): mesma cobertura de `lead.ts` adaptada às 4 header sections do broker e aos campos do bloco de interação broker (`Lead em contexto`, `Dificuldade`, `Encaminhamento`); `MALFORMED_BROKER_BODY` em blocos quebrados; `pendencias_abertas` e `dificuldades_recorrentes` round-trip como listas markdown; campos executivos `nivel_atencao` (string livre, vocabulário canônico em §5.6) e `ultima_acao_recomendada` (rejeitado se contiver `\n`).
- `financial.ts` (parser/serializer dedicado): parse das 5 seções literais (`## Caixa`, `## Receita`, `## Despesa`, `## Alertas`, `## Contexto adicional`); seção ausente vira `null` (não bloqueia); `## Alertas` sem itens vira `[]`; auto-extração de campos `*_resumo` (primeira linha não-vazia da seção correspondente); auto-cálculo de `alertas_count`; rejeição de `*_resumo` com quebra de linha; `period` validado como `YYYY-MM`.

### 8.2 Integração (vitest + fixture)

- `test/fixtures/vault/`: mini-vault com 2 agentes (`alfa`, `beta`) e 5 notas incluindo `decisions.md` e um journal.
- `create_journal_entry` → arquivo existe, frontmatter correto, índice atualizado.
- `append_decision` → prepend correto, ordem temporal preservada, idempotência em crash parcial simulado.
- `read_agent_context` → bundle completo, respeita `n_decisions`/`n_journals`.
- `get_agent_delta` → grid de escritas timestamped garante retorno apenas de arquivos com `mtime > since`; `types?` filtra corretamente; agrupamento por tipo correto; `include_content` alterna entre preview e content full.
- `get_shared_context_delta` → fixture com shared-contexts escritos por 3 agentes diferentes em 3 tópicos canônicos (`opt-out`, `objecoes`, `aprendizados`); chamada com `since` no meio do grid retorna apenas os posteriores; `topics=['opt-out']` filtra por tópico; `owners=['reno']` filtra por autor; combinação `topics+owners` aplica AND; agrupamento `by_topic` correto; `total` bate com soma dos grupos. A tool **não** tem `caller_agent` — não exclui implicitamente quem chamou; quem quiser apenas o que OUTROS escreveram passa `owners` explicitamente excluindo a si mesmo (decisão deliberada para manter API stateless e simétrica).
- `get_training_target_delta` → fixture com (a) Reno escrevendo 1 decision + 1 journal + 1 shared-context em `objecoes/`; (b) Sparring escrevendo 2 regressões em `regressoes/sparring/` ambas com `#alvo-reno`, status=`aberta`, severidades distintas; (c) FamaAgent escrevendo 1 shared-context em `aprendizados/` com `#alvo-reno`. Chamada `get_training_target_delta(target_agent='reno', since=<antes>)` deve retornar: `target_agent_delta` com 3 itens do Reno; `shared_about_target` com 3 itens (2 regressões + 1 aprendizado, todos mencionam `#alvo-reno`); `regressions` com 2 itens (subset projetado, com `status='aberta'`, `severidade` e `categoria` parseados do body convention §5.8); `total=8` (3+3+2, sem dedup). Validar também: shared-context sem tag `#alvo-reno` mas com `Agente alvo: reno` no body é capturado; divergência body↔tag (`#regressao-aberta` mas `Status: corrigida`) emite warning e body vence.
- `upsert_financial_snapshot` → cria `_shared/financials/2026-04/cfo-exec.md` com 5 seções na ordem; frontmatter inclui `type=financial-snapshot`, `period=2026-04`, `alertas_count` igual a `len(alertas)`; auto-extração de `caixa_resumo`/`receita_resumo`/`despesa_resumo` da primeira linha não-vazia das seções quando não passados explicitamente; segundo upsert preserva campos não passados; `period='2026-4'` (sem zero) rejeitado com `INVALID_PERIOD`; `caixa_resumo='linha1\nlinha2'` rejeitado com `INVALID_FRONTMATTER` (campo de uma linha).
- `read_financial_series` → fixture com 4 snapshots (2026-01, 2026-02, 2026-03, 2026-04). Modo `since='2026-02', until='2026-04', order='desc'` retorna 3 snapshots (04, 03, 02) parseados estruturadamente; modo `periods=['2026-04','2026-01']` retorna 2 snapshots; modo `periods=['2026-04','2025-12']` retorna 1 snapshot + erro `SNAPSHOT_NOT_FOUND` para `2025-12` (sinaliza expectativa quando period explícito); seções ausentes do body viram `null` no retorno; `## Alertas` vazio retorna `[]`; `limit=2` trunca para 2 itens.
- `get_broker_operational_summary` → fixture com broker `Maria Eduarda` tendo `nivel_atencao=atencao`, `ultima_acao_recomendada=ligar...`, 2 pendências, 5 interações ao longo dos últimos 28 dias com 2 idênticas `Dificuldade: objeção entrada`. Chamada `get_broker_operational_summary("ceo-exec","Maria Eduarda")` retorna: `broker.nivel_atencao='atencao'` e `ultima_acao_recomendada` populado; `pendencias_abertas` com 2 itens; `recent_interactions` com 5; `dias_desde_ultima_interacao` calculado corretamente; `dificuldades_repetidas=[{dificuldade:'objeção entrada',count:2}]`; `sinais_de_risco` inclui string mencionando a dificuldade repetida; `total_interacoes_periodo_atual=5` e `total_interacoes_periodo_anterior` calculado para janela 28-56 dias atrás. Validar broker sem interações: `dias_desde_ultima_interacao=null`, `sinais_de_risco=[]`. Validar `BROKER_NOT_FOUND` em broker inexistente.
- `list_brokers_needing_attention` → fixture com 5 brokers sob `ceo-exec`: 1 `normal` (sem pendências, interação recente), 2 `atencao`, 1 `risco`, 1 `critico` (com 5 dias de inatividade, 4 pendências, 2 dificuldades repetidas). Chamada com defaults retorna 4 brokers (exclui `normal`), ordem `desc` por `priority_score` com `critico` no topo (validar valor exato do score: `5 + 4*3 + 2*2 + 30 = 51`). `risk_levels=['critico']` retorna 1 broker; `equipes=['centro']` filtra subset por equipe; `min_pendencias=3` retorna apenas brokers com 3+ pendências; `order='alphabetical'` lista por `broker_name` ASC; `order='last_interaction'` ordena por `dias_desde_ultima_interacao` desc. `since='3d'` (relativo) e `since='2026-04-13T00:00:00Z'` (ISO) ambos válidos; `since='abc'` retorna `INVALID_RELATIVE_TIME`.
- **Body convention de regressões:** parser de `regressoes/` extrai os 7 campos do body convention §5.8 (Agente alvo, Cenário, Comportamento esperado, Comportamento observado, Severidade, Status, Categoria); campos ausentes viram `null` no retorno estruturado; campo `Histórico` opcional é parseado como lista de timestamps quando presente.
- `upsert_shared_context` → path montado corretamente; `type: shared-context` injetado; segunda escrita do mesmo autor atualiza; escrita de `beta` em path do `alfa` rejeitada com `OWNERSHIP_VIOLATION`.
- `upsert_entity_profile` → slug derivado de `entity_name` (ASCII-fold + kebab); `type: entity-profile` com `entity_type`/`entity_name` injetados; kebab validation em `entity_type` rejeita valores com espaço/slash.
- `upsert_lead_timeline` → cria `_agents/reno/lead/<slug>.md` com 5 seções na ordem; segundo upsert preserva `## Histórico de interações` intacto e atualiza só os 4 headers passados; campos não passados em update mantêm valor anterior; frontmatter inclui `entity_type=lead` + campos lead-comerciais.
- `append_lead_interaction` → bloco anexado no fim de `## Histórico de interações`; cria a seção se ausente; `timestamp` default = agora; tags entram como `Tags: #...` no fim do bloco; `LEAD_NOT_FOUND` se doc inexistente; ordem cronológica preservada (mais antigo no topo).
- `read_lead_history` → parseia frontmatter + 4 headers como `lead`; blocos da seção histórico como `interactions`; `since` filtra; `order='desc'` retorna recentes primeiro; bloco com formato quebrado vira `MALFORMED_LEAD_BODY` warning e fica fora do retorno; header section ausente vira `null` em `lead.<campo>`.
- `upsert_broker_profile` → cria `_agents/famaagent/broker/<slug>.md` com 5 seções na ordem (4 broker-específicas + histórico); segundo upsert preserva histórico e atualiza só os 4 headers passados; campos não passados em update mantêm valor anterior; frontmatter inclui `entity_type=broker` + campos broker-operacionais (`equipe`, `nivel_engajamento`, contato, `pendencias_abertas`).
- `append_broker_interaction` → bloco anexado no fim de `## Histórico de interações` com campos broker (`Canal`, `Lead em contexto`, `Resumo`, `Dificuldade`, `Encaminhamento`, `Tags`); `BROKER_NOT_FOUND` se doc inexistente; `contexto_lead?` opcional (broker pode ter interação não-ancorada a um lead específico).
- `read_broker_history` → parse correto; **escopado a um único broker_name** (verificar que tentar passar lista falha em validação de tipo); `since` filtra; ordem configurável; `MALFORMED_BROKER_BODY` análogo ao lead.
- **Isolamento broker (§5.7) — teste de regressão:** vault de fixture com 2 brokers (`alfa`, `beta`) sob o mesmo `famaagent`. `read_broker_history(broker_name='alfa')` retorna apenas dados de `alfa`; nenhum dado de `beta` aparece no retorno mesmo com matching tags ou conteúdo similar. Ausência de tool aggregate é validada por `tools/list` não conter `read_brokers_aggregate` ou similar.
- **Filtros temporais centrais:** `search_content`, `search_by_tag`, `search_by_type`, `list_folder` com `since`/`until` retornam apenas notas com `mtime` na janela; `since > until` ou ISO inválido retorna `INVALID_TIME_RANGE`. Janela vazia (sem hits) retorna `{... : []}` sem erro.
- Filtro `owner` em `search_content`, `list_folder`, `search_by_tag`, `search_by_type` → multi-valor funciona; agente desconhecido retorna `INVALID_OWNER` com lista de owners válidos.
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

1. 34 tools + 2 resources registrados e descobríveis via `tools/list`.
2. Suite de testes passa com coverage ≥ 80% em `vault/`.
3. Ownership enforcement bloqueia 100% das escritas cross-agent nos testes.
4. `read_agent_context("ceo")` retorna bundle completo em < 200ms no vault real.
5. Stress concorrência passa o critério de zero corruption (§8.4).
6. Deploy em VPS de staging + smoke test em `mcp-obsidian.famachat.com.br` passa.
7. `README.md` documenta cada tool com exemplo + troubleshooting comum (GIT_LOCK_BUSY, OWNERSHIP_VIOLATION, INVALID_OWNER, LEAD_NOT_FOUND, MALFORMED_LEAD_BODY, BROKER_NOT_FOUND, MALFORMED_BROKER_BODY, INVALID_TIME_RANGE, INVALID_RELATIVE_TIME, SNAPSHOT_NOT_FOUND, INVALID_PERIOD) + seção "Governance vault ≠ CRM" replicando §1.1 + seção "Taxonomia canônica de shared context" replicando §5.8 (lista dos 6 tópicos canônicos com semântica resumida + body conventions de `opt-out/` e `regressoes/` + vocabulário canônico de tags de regressão) + seção "Padrão financial-snapshot" replicando §5.9 (path canônico, 5 seções do body, política de auto-extração, reafirmação textual vs numérico) + seção "Campos executivos do broker" documentando vocabulário de `nivel_atencao` e convenção de `ultima_acao_recomendada` + fórmula explícita do `priority_score` de `list_brokers_needing_attention`.
8. `get_agent_delta` retorna exatamente o conjunto de arquivos com `mtime > since` e `owner == agent`, validado por grid de escritas timestamped no teste de integração.
9. `upsert_shared_context` cria arquivos em `_shared/context/<topic>/<agent>/<slug>.md` com `type: shared-context` e ownership path-based; tentativa de `write_note` cross-agent no path de outro autor (ex.: `beta` escrevendo em `_shared/context/<topic>/alfa/<slug>.md`) é rejeitada com `OWNERSHIP_VIOLATION`.
10. **Lead-history Reno (validação end-to-end):** sequência `upsert_lead_timeline("reno", "João Silva", ...)` → 3× `append_lead_interaction(...)` → `read_lead_history("reno", "João Silva")` retorna `lead` com os 4 header fields populados e `interactions` com exatamente 3 itens em ordem `desc` (mais recente primeiro), todos parseados corretamente do bloco. Update do timeline com `proximo_passo` novo preserva os 3 blocos do histórico intactos.
11. **Robustez do parser de lead:** `read_lead_history` aplicado a doc com 1 bloco bem-formado + 1 bloco malformado retorna 1 `interaction` válida + 1 `MALFORMED_LEAD_BODY` warning citando o número da linha de início do bloco rejeitado e o motivo (regex de timestamp falhou, linha `Chave: valor` malformada, etc.), sem falhar a chamada.
12. **Broker-history FamaAgent (validação end-to-end):** sequência `upsert_broker_profile("famaagent", "Maria Eduarda", equipe="centro", nivel_engajamento="ativo", ...)` → 3× `append_broker_interaction(...)` → `read_broker_history("famaagent", "Maria Eduarda")` retorna `broker` com os 4 header fields populados e `interactions` com 3 itens parseados corretamente. Update do profile preserva o histórico.
13. **Isolamento broker (§5.7):** com 2 brokers (`maria-eduarda`, `joao-pedro`) sob `famaagent`, `read_broker_history(broker_name='maria-eduarda')` retorna apenas dados de Maria Eduarda; nenhum dado de João Pedro aparece no retorno mesmo se ambos compartilharem tags. `tools/list` não contém nenhuma tool de aggregation cross-broker (validado por nome).
14. **Filtros temporais centrais:** `search_content(query='objeção', since='2026-04-09T00:00:00Z')` aplicado a vault com 5 notas matching mas só 2 com `mtime` na janela retorna exatamente as 2; mesmo comportamento para `search_by_tag`, `search_by_type`, `list_folder`. `INVALID_TIME_RANGE` para `since='não-é-data'` ou `since > until`.
15. **Heartbeat Follow-up (validação end-to-end):** sequência `upsert_shared_context("reno", topic="opt-out", slug="whatsapp-bloco", title="...", content="...")` → `upsert_shared_context("famaagent", topic="objecoes", slug="entrada-alta", ...)` → `get_shared_context_delta(since=<antes_da_sequencia>, topics=["opt-out","objecoes"])` retorna exatamente os 2 arquivos agrupados em `by_topic.opt-out` e `by_topic.objecoes`, com `owner='reno'` e `owner='famaagent'` respectivamente, e `total=2`. Critério inclui validar que adicionar uma escrita em tópico fora do filtro (ex.: `aprendizados`) NÃO aparece no retorno.
16. **Bateria Sparring (validação end-to-end):** sequência `append_decision("reno", ...)` → `upsert_shared_context("sparring", topic="regressoes", slug="reno-tom-frio", title="...", content=<body convention §5.8 com Status=aberta, Severidade=alta, Categoria=tom, Agente alvo=reno>, tags=["#alvo-reno", "#regressao-aberta", "#severidade-alta", "#categoria-tom"])` → `upsert_shared_context("famaagent", topic="aprendizados", slug="cef-renda-baixa", tags=["#alvo-reno"], ...)` → `get_training_target_delta(target_agent="reno", since=<antes>)` retorna: `target_agent_delta` com a decision do Reno; `shared_about_target` com 2 itens (regressão + aprendizado); `regressions` com 1 item (a regressão), com `status='aberta'`, `severidade='alta'`, `categoria='tom'` parseados do body. `total=4`.
17. **Snapshot financeiro cfo-exec (E2E):** sequência de 3× `upsert_financial_snapshot("cfo-exec", period="2026-02"/"2026-03"/"2026-04", ...)` com bodies completos das 5 seções → `read_financial_series("cfo-exec", since="2026-02", until="2026-04")` retorna 3 snapshots em ordem `desc` (2026-04 primeiro), com 5 seções parseadas estruturadamente em cada item e campos `*_resumo` populados (auto-extraídos quando não passados explicitamente); `read_financial_series("cfo-exec", periods=["2026-04","2026-01"])` retorna 1 snapshot encontrado + erro `SNAPSHOT_NOT_FOUND` para `2026-01` (não escrito no fixture).
18. **Resumo executivo broker ceo-exec (E2E):** sequência `upsert_broker_profile("ceo-exec", broker_name="Maria Eduarda", nivel_atencao="atencao", ultima_acao_recomendada="ligar para alinhar pendência", pendencias_abertas=["X","Y"])` → 5× `append_broker_interaction(...)` ao longo de 28 dias com 2 interações compartilhando `Dificuldade: objeção entrada` → `get_broker_operational_summary("ceo-exec", "Maria Eduarda")` retorna `broker.nivel_atencao='atencao'`, `dias_desde_ultima_interacao` calculado correto, `dificuldades_repetidas=[{dificuldade:'objeção entrada',count:2}]`, `sinais_de_risco` populado com strings descritivas, `total_interacoes` para janela atual e anterior. Validar `ultima_acao_recomendada='linha\ncom\nbreak'` em `upsert_broker_profile` rejeitado com `INVALID_FRONTMATTER`.
19. **Carteira priorizada ceo-exec (E2E):** fixture com 5 brokers de níveis variados (1 `normal`, 2 `atencao`, 1 `risco`, 1 `critico`); o `critico` tem 5 dias de inatividade, 4 pendências e 2 dificuldades repetidas. `list_brokers_needing_attention("ceo-exec")` com defaults retorna 4 brokers (exclui `normal`), ordenados por `priority_score` desc com `critico` no topo (score=51). `risk_levels=['critico']` retorna apenas 1; `equipes=['centro']` filtra subset; `min_pendencias=3` retorna apenas brokers com 3+ pendências. `since='abc'` retorna `INVALID_RELATIVE_TIME`.

## 10. Fora de escopo (YAGNI)

- Watcher (chokidar) — mtime lazy basta.
- Full-text indexing customizado — ripgrep resolve.
- Multi-vault.
- Web UI de administração.
- Métricas Prometheus.
- Backup dedicado (cron já replica via git remote).
- Pull automático antes de reads (confia no cron).
- Tipos extras além dos 15 atuais.
- Allowlist de exceções de ownership (adicionar quando surgir necessidade real).
- Delta com deleções em `get_agent_delta` — `audit.log` (§6.3) já registra deletes; leitura direta cobre os raros consumidores. Integrar deletes no índice vira fonte-de-verdade paralela.
- `upsert_shared_context` append-only — owner pode atualizar o próprio arquivo livremente; co-autoria intra-arquivo não é MVP (cada autor cria seu próprio slug dentro do `<topic>/`).
- `list_entities`/`search_entities` dedicados — enquanto `list_folder` + filtro `owner` + `search_by_type` cobrirem o caso, não vale tool dedicada. **Marcado como prioritário caso volume de leads/entidades cresça.**
- Edição/deleção de interações individuais em `## Histórico de interações` — append-only por design (vale tanto lead quanto broker); correções viram nova interação. Limpeza profunda exige `write_note` direto + commit message justificando.
- Tools paralelas para outros entity_types (imovel, conversa, construtora) — só viram first-class com tools dedicadas se o volume e o atrito ergonômico justificarem (ver §11). Para o MVP, lead e broker são os dois entity_types first-class; demais usam `upsert_entity_profile` genérico.
- **Cross-broker aggregation dedicada** (`read_brokers_aggregate`, `search_across_brokers`) — **ausência deliberada** (§5.7), não esquecimento. Aggregation legítima se compõe com `list_folder` + N reads explícitos, forçando deliberação do agente vs acidente durante atendimento de um broker.
- Session scope técnico no MCP ("famaagent atendendo broker A agora") — MCP é stateless; isolamento é convenção + tool design naturalmente scoped (§5.7).
- Validação automática de "dado parece ser de CRM/sensível" em writes — falsos positivos tornariam unusable; governance §1.1 fica por convenção + auditoria humana.
- **Enforcement da taxonomia canônica §5.8** (rejeitar `topic` fora dos 5 canônicos em `upsert_shared_context`) — flexibilidade vence rigidez nessa fase. Tópicos não-canônicos são permitidos e a convenção orienta promoção via revisão da spec quando se firmarem (3+ usos consistentes).
- Notificação automática (push) quando shared-context mudar — fora de escopo de MCP stateless. Agentes que precisam ficar atualizados fazem pull via `get_shared_context_delta` no heartbeat deles.
- Tool dedicada `register_opt_out_signal` — `upsert_shared_context` + convenção §5.8 (body schema para `opt-out/`) cobrem o caso. Tool dedicada não adiciona valor além do schema (que é convenção).
- **Enforcement das tags canônicas de `regressoes/`** (rejeitar shared-context em `regressoes/` sem `#alvo-<agent>` ou status/severidade/categoria) — convenção mais rigorosa documentada em §5.8 mas sem hard block; promove a enforcement só se Sparring começar a sofrer com inconsistência empírica.
- **Busca semântica para erros equivalentes** ("lead frio" = "despedida seca" = "frieza" = "baixa tração") — reconhecido pelo Sparring como gap real, mas fora de escopo do MCP genérico. Vault depende de ripgrep + tags + convenção. Adicionar embeddings/semantic search é mudança arquitetural significativa, não wrapper — entra em §11 só se o atrito empírico justificar a complexidade.
- **Auto-tagging baseado em heurísticas** em `regressoes/` (parser tentando inferir `#categoria-<x>` do body) — falsos positivos quebrariam a confiança no índice; tags ficam manuais.
- **Comparação cross-período computada pelo MCP** em snapshots financeiros (ex.: tool retornando `delta_caixa: -12%` entre meses) — agente recebe a série estruturada via `read_financial_series` e calcula no próprio raciocínio. Adicionar lógica de diff numérica reintroduz o que §1.1 quer evitar (vault virando planilha).
- **Validação automática de "valor numérico parece detalhado demais"** em campos de snapshot financeiro — falsos positivos; convenção §1.1+§5.9 fica por disciplina humana e revisão.
- **Score executivo de "saúde do broker" como número único 0-100** — risco de virar métrica enganosa que mascara o contexto. `get_broker_operational_summary` retorna fatos descritivos; `list_brokers_needing_attention` usa `priority_score` apenas como **critério de ordenação** (fórmula fixa documentada), não como métrica reportada como "saúde geral".
- **Auto-detect de mudança de `nivel_atencao`** baseado em heurísticas (ex.: 7+ dias inatividade → marca como `risco` automaticamente) — falsos positivos. Mudança de nível é sempre decisão explícita do agente via `upsert_broker_profile`; o MCP fornece `sinais_de_risco` no `get_broker_operational_summary` para informar essa decisão sem tomá-la pelo agente.
- **Computação de "tendência" como número** (delta% etc.) em `get_broker_operational_summary` — retorna contagens das duas janelas (`total_interacoes_periodo_atual`/`anterior`) e agente compara textualmente. Mesma justificativa do snapshot financeiro: dados estruturados, não cálculo opinionated.
- **Score customizável** em `list_brokers_needing_attention` (peso configurável de cada componente da fórmula) — fórmula fixa é mais previsível e auditável. Quem precisa de outra ordenação usa `order='alphabetical'` ou `order='last_interaction'` e reordena no próprio raciocínio.

## 11. Upgrade paths (não implementar agora)

- Ownership allowlist configurável → promove A → D sem breaking change na API das tools.
- Pull-before-read e push-after-write automáticos → promove B → D (campo `sync_mode` em config).
- Watcher → se vault crescer significativamente (> 20k notas), substitui mtime lazy.
- Strict wikilinks → flag já existe (`STRICT_WIKILINKS`), basta mudar o default.
- `move_note(from, to, as_agent)` na Camada 1 → renomeia arquivo + reescreve wikilinks de notas que apontam pra ele; idempotente (destino já existente e source ausente = sucesso). Fora do MVP porque o workflow atual (read + write + delete) funciona, apesar de quebrar wikilinks; entra quando surgir necessidade real de renomear pastas/títulos sem órfãos.
- Tokens por agente (`MCP_TOKEN_<AGENT>`) → MCP valida `as_agent` contra o token apresentado, eliminando o risco de "quem tem o token assume qualquer identidade". Modelo atual assume token tão sensível quanto senha de banco; upgrade quando o custo operacional de rotação por agente for aceitável.
- `idempotency_key` opcional em `append_decision` (e possivelmente outras writes) → cliente envia UUID; MCP deduplica dentro de janela curta para evitar entradas duplicadas quando a resposta HTTP se perde e o agente retenta.
- Commits agrupados por `as_agent` em `commit_and_push` → elimina commits "mistos" descritos em §4.3 quando virarem atrito real.
- `list_entities(agent, entity_type?)` e `search_entities(query, entity_type?, status?)` → habilitados pelo schema estruturado de `entity-profile` (§5.1); entram quando volume de entidades (corretores/leads/imóveis) crescer a ponto de `list_folder` + filtros virarem ergonomicamente ruins.
- Delta com deleções → ler `audit.log` dentro de `get_agent_delta` e retornar `deletions: [{path, deleted_at, reason}]`. Simples mas não faz sentido enquanto ninguém reclamar.
- Co-autoria em `shared-context` → remover o segmento `<agent>/` do path e permitir múltiplos autores por arquivo com section-level ownership (cabeçalhos `## <agent>:`). Breaking change; só vale se o padrão atual (um arquivo por autor por tópico) gerar fragmentação que atrapalhe leitura.
- Tools timeline/interaction para outros entity_types — `upsert_<entity>_timeline`/`upsert_<entity>_profile` + `append_<entity>_interaction` + `read_<entity>_history`, no padrão estabelecido por lead (§5.5) e broker (§5.6), para `imovel`, `conversa`, `construtora`, etc. Cada conjunto novo replica o template com campos próprios. Promove quando o entity_type virar "first-class" para algum agente (volume + atrito ergonômico justificando wrapper dedicado vs `upsert_entity_profile` + `append_to_note`).
- **Consolidação de parsers** — quando aterrissar o terceiro `<entity>.ts` parser/serializer (após `lead.ts` e `broker.ts`), refatorar para `entity-history.ts` genérico parametrizado pelos schemas. Para 2 parsers a duplicação é aceitável; para 3+ vale o DRY.
- Editor de interações lead/broker (correções em bloco do histórico) → `edit_<entity>_interaction(<entity>_name, block_timestamp, ...new_fields)` que reescreve um bloco específico identificado por timestamp. Quebra append-only; só vale se acumular muitos casos de necessidade real de correção pós-fato.
- **Cross-broker aggregation dedicada** — quando o FamaAgent tiver caso real e recorrente de "preciso de uma view agregada de todos os brokers" (relatórios mensais, dashboards), promover `read_brokers_summary(filters)` que internamente compõe `list_folder` + N reads. Hoje o agente faz manualmente; tool dedicada elimina boilerplate quando padrão se firmar.
- **Enforcement governance §1.1** — heurísticas de detecção de "dado parece sensível" (regex CPF/CNPJ, valores monetários grandes, etc.) com modo `warn`/`block` configurável. Só vale após acumular evidência empírica de violações reais — falsos positivos cedo demais minam adoção.
- **Token por broker_id** (extensão de "tokens por agente") — em cenários multi-tenant onde brokers diferentes não devem ver dados uns dos outros mesmo via mesmo agente. Hoje confiamos na disciplina do agente (§5.7); upgrade quando isso virar requisito formal.
- **`validate_taxonomy()`** — escaneia todos os shared-contexts e reporta tópicos fora dos 5 canônicos de §5.8, frequência de uso de cada tópico, e candidatos a promoção (tópicos não-canônicos com 3+ usos por agentes diferentes). Rodada periódica de governance do vocabulário; útil quando o número de tópicos não-canônicos exigir limpeza/consolidação.
- **`register_opt_out_signal(as_agent, sinal, canal, severidade, acao_recomendada, evidence?)`** — wrapper estruturado sobre `upsert_shared_context(topic='opt-out', ...)` que enforce o body schema de §5.8. Promove quando volume de opt-out justificar reduzir o atrito ergonômico de montar o markdown manualmente.
- **Push/notify para shared-context delta** — webhook ou pub/sub que avisa agentes interessados quando shared-context relevante muda, em vez de pull via `get_shared_context_delta`. Vale quando heartbeats virarem caros ou os SLAs de propagação ficarem mais apertados que os 5 min do `brain-sync`.
- **`upsert_regression_context(target_agent, scenario, expected, observed, severidade, categoria, status?)`** — wrapper estruturado sobre `upsert_shared_context(topic='regressoes', ...)` que enforce o body convention §5.8 e gera tags canônicas automaticamente (`#alvo-<target>`, `#regressao-<status>`, `#severidade-<n>`, `#categoria-<c>`). Promove quando volume de baterias do Sparring justificar reduzir o atrito ergonômico; o próprio Sparring classificou como "considerar futuro se volume crescer".
- **`read_regression_summary(target_agent?, status?, severidade?, categoria?)`** — view consolidada de regressões abertas com filtros estruturados, retornando counts + lista. Mais ergonômico que compor `search_by_tag` múltiplas; entra junto com `upsert_regression_context` quando volume justificar.
- **Busca semântica (embeddings) para erros equivalentes** — quando o problema de "lead frio = frieza = baixa tração" virar atrito real e a disciplina de tags se mostrar insuficiente. Custo arquitetural significativo (embeddings model + vector store); só vale se o ROI estiver claro.
- **`compare_financial_snapshots(as_agent, periods, fields?)`** — retorna deltas estruturados por seção/campo entre múltiplos snapshots. Faz sentido se houver UI consumindo (dashboards) ou se a comparação manual virar atrito ergonômico recorrente para cfo-exec. Cuidado: introduzir computação numérica aqui pode forçar reabertura da decisão de §5.9 sobre campos textuais; melhor entrar como tool **textual diff** (mostra blocos diferentes, não calcula deltas).
- **`upsert_financial_alert`** dedicado — wrapper sobre `upsert_shared_context(topic='aprendizados', ...)` ou tópico canônico novo `alertas-financeiros/` se volume justificar manter alertas históricos navegáveis fora dos snapshots mensais.
- **`set_broker_attention_level(broker_name, nivel_atencao, motivo)`** — wrapper sobre `upsert_broker_profile` que registra também uma linha no histórico (ex.: "Nível de atenção mudado de `atencao` para `risco` por motivo Z em 2026-04-16") — útil para trilha auditável de mudanças de nível, especialmente em escalações para `critico`.
- **Índice secundário em memória por `nivel_atencao`** — promove performance de `list_brokers_needing_attention` quando vault crescer (>200 brokers). Hoje a tool faz scan linear de todos os brokers do agente; índice secundário tornaria filtros por `nivel_atencao` O(1).
- **`get_brokers_aggregate_stats(as_agent, since?)`** — métricas de carteira (count por `nivel_atencao`, % com pendências, distribuição por equipe, etc.) — síntese ainda mais alta para reports executivos. Promove quando o ceo-exec demandar reports periódicos sintéticos vs queries pontuais.
