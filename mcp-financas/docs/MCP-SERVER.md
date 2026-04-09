# MCP PostgreSQL Server — Controle Financeiro

Servidor MCP (Model Context Protocol) que conecta agentes de IA ao banco de dados PostgreSQL de controle financeiro, expondo 23 ferramentas e 2 recursos para consulta, análise e gestão de finanças pessoais e empresariais.

---

## Sumário

1. [Visão Geral](#visão-geral)
2. [Arquitetura](#arquitetura)
3. [Configuração](#configuração)
4. [Autenticação e Segurança](#autenticação-e-segurança)
5. [Endpoints HTTP](#endpoints-http)
6. [Recursos MCP](#recursos-mcp)
7. [Ferramentas MCP](#ferramentas-mcp)
   - [Generic (6)](#generic-6-ferramentas)
   - [Admin (6)](#admin-6-ferramentas)
   - [Financas (11)](#financas-11-ferramentas)
8. [Modelo de Dados](#modelo-de-dados)
9. [Deploy](#deploy)
10. [Configuração do Cliente MCP](#configuração-do-cliente-mcp)
11. [Monitoramento](#monitoramento)

---

## Visão Geral

| Item | Detalhe |
|------|---------|
| **Nome** | `postgres-financas` |
| **Versão** | 1.0.0 |
| **Protocolo** | MCP (Model Context Protocol) |
| **Transporte** | Streamable HTTP (stateless) |
| **URL de Produção** | `https://mcp-financas-postgres.famachat.com.br/mcp` |
| **Banco de Dados** | PostgreSQL (`financas`) |
| **Ferramentas** | 23 |
| **Recursos** | 2 |

### Stack Tecnológico

- **Runtime:** Node.js 20 (Alpine)
- **Linguagem:** TypeScript (ES2022)
- **Framework HTTP:** Express 4
- **MCP SDK:** `@modelcontextprotocol/sdk` 1.27+
- **Driver DB:** `pg` 8.13+
- **Validação:** Zod 3.24+
- **Segurança:** Helmet 8, express-rate-limit 7

---

## Arquitetura

```
┌─────────────────────────────────────────────────────┐
│                  Clientes MCP                        │
│         (Claude Desktop, Cursor, N8N, etc.)          │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS (porta 443)
                       ▼
              ┌─────────────────┐
              │    Traefik 2.11  │   Reverse proxy + SSL automático
              │   (Let's Encrypt)│   mcp-financas-postgres.famachat.com.br
              └────────┬────────┘
                       │ network_public (overlay)
                       ▼
              ┌─────────────────┐
              │  MCP Server      │   Node.js (porta 3101)
              │  (Express)       │
              │                  │
              │  ┌────────────┐  │
              │  │  Helmet     │  │   Headers de segurança
              │  ├────────────┤  │
              │  │  Logger     │  │   Log de requisições
              │  ├────────────┤  │
              │  │ Rate Limit  │  │   300 req/min
              │  ├────────────┤  │
              │  │  Auth       │  │   Bearer Token
              │  ├────────────┤  │
              │  │ MCP Handler │  │   23 tools + 2 resources
              │  └────────────┘  │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   PostgreSQL     │
              │  144.126.134.23  │   porta 5432
              │  Database:       │
              │  financas        │
              └─────────────────┘
```

### Modo Stateless

O servidor opera em modo **stateless** — cada requisição `POST /mcp` cria um transport independente, sem rastreamento de sessão. Isso simplifica o deploy e permite reinícios sem impacto.

---

## Configuração

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `DATABASE_URL` | String de conexão PostgreSQL | **obrigatório** |
| `API_KEY` | Token Bearer para autenticação | **obrigatório** |
| `PORT` | Porta do servidor HTTP | `3101` |
| `DB_POOL_MAX` | Máximo de conexões no pool | `20` |
| `QUERY_TIMEOUT_MS` | Timeout de queries (ms) | `30000` |
| `RATE_LIMIT_RPM` | Requisições por minuto | `300` |
| `NODE_ENV` | Ambiente de execução | — |

---

## Autenticação e Segurança

### Bearer Token

Todas as rotas (exceto `/health`) exigem o header:

```
Authorization: Bearer <API_KEY>
```

| Código | Significado |
|--------|-------------|
| `401` | Header Authorization ausente ou mal formatado |
| `403` | API Key inválida |
| `429` | Rate limit excedido |

### Camadas de Segurança

- **HTTPS** — Certificado SSL automático via Traefik + Let's Encrypt
- **Helmet** — Headers de segurança (CSP, X-Frame-Options, HSTS, etc.)
- **Rate Limiting** — 300 requisições/minuto por IP (configurável)
- **Queries Parametrizadas** — Todas as ferramentas usam `$1, $2, ...` para prevenir SQL injection
- **Usuário não-root** — Container roda como usuário `node`
- **Rede isolada** — Comunicação entre containers via rede overlay do Docker Swarm

---

## Endpoints HTTP

### `GET /health`

Health check do servidor. Não requer autenticação.

**Resposta (200):**
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2026-03-25T16:05:50.065Z"
}
```

**Resposta (503):** Banco de dados desconectado.

### `POST /mcp`

Endpoint principal do MCP. Recebe requisições JSON-RPC 2.0. Modo stateless — cada request cria um transport independente.

**Headers obrigatórios:**
```
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <API_KEY>
```

### `GET /mcp`

Retorna 405 — SSE não suportado em modo stateless.

### `DELETE /mcp`

Retorna 405 — sem sessões para encerrar em modo stateless.

---

## Recursos MCP

### `postgres://schema`

Esquema completo do banco de dados: tabelas, colunas, tipos, relacionamentos e enums.

**Retorno:**
```json
{
  "tables": {
    "categories": [
      {"column_name": "id", "data_type": "uuid", "is_nullable": "NO", ...},
      ...
    ],
    "transactions": [...]
  },
  "foreign_keys": [
    {"source_table": "transactions", "source_column": "category_id", "target_table": "categories", "target_column": "id"}
  ],
  "enums": [
    {"enum_name": "category_type", "values": ["receita", "despesa", "ambos"]},
    {"enum_name": "transaction_type", "values": ["receita", "despesa"]},
    {"enum_name": "scope", "values": ["pessoal", "empresa"]},
    {"enum_name": "transaction_kind", "values": ["unica", "parcelamento", "recorrente"]},
    {"enum_name": "frequency", "values": ["mensal", "semanal", "anual"]}
  ]
}
```

### `postgres://stats`

Dashboard de saúde do banco: cache, conexões, bloat, vacuum.

**Retorno:**
```json
{
  "health": {
    "db_size": "192 kB",
    "cache_hit_pct": "99.85",
    "connections": 5,
    "commits": 150000,
    "rollbacks": 12
  },
  "top_bloat_tables": [
    {"relname": "transactions", "n_live_tup": 110, "n_dead_tup": 0, "dead_pct": "0.00", ...},
    ...
  ]
}
```

---

## Ferramentas MCP

### Generic (6 ferramentas)

#### `query`
Executa SQL arbitrário contra o banco de dados.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `sql` | string | sim | Statement SQL |
| `params` | array | não | Parâmetros para queries parametrizadas ($1, $2, ...) |
| `timeout_ms` | number | não | Timeout em milissegundos (padrão: 30000) |

**Retorno:** `{rowCount, rows, fields[{name, dataType}]}`

---

#### `list_tables`
Lista todas as tabelas com contagem de linhas, tamanhos e índices.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `schema` | string | não | Schema (padrão: `public`) |

**Retorno:** Array de tabelas com `table_name, row_count, table_size, index_size, total_size`

---

#### `describe_table`
Mostra o esquema completo de uma tabela: colunas, tipos, constraints, índices e chaves estrangeiras.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `table` | string | sim | Nome da tabela |
| `schema` | string | não | Schema (padrão: `public`) |

**Retorno:** `{table, columns[], indexes[], foreign_keys[], constraints[]}`

---

#### `list_relationships`
Mostra todas as relações de chave estrangeira entre tabelas.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `table` | string | não | Filtrar por tabela |

**Retorno:** Array de relacionamentos `{source_table, source_column, target_table, target_column}`

---

#### `explain_query`
Executa EXPLAIN ANALYZE para ver o plano de execução de uma query.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `sql` | string | sim | Query SQL |

**Retorno:** Plano de execução formatado em texto

---

#### `list_enums`
Lista todos os tipos enum customizados e seus valores.

**Sem parâmetros.**

**Retorno:** Array de enums `{enum_name, values[]}`

---

### Admin (6 ferramentas)

#### `database_stats`
Saúde geral do banco: tamanho, cache hit rate, conexões, commits/rollbacks, uptime.

**Sem parâmetros.**

**Retorno:**
```json
{
  "database": {"db_size", "cache_hit_pct", "active_connections", ...},
  "connections": {"total", "active", "idle", "idle_in_tx"},
  "settings": [{"name", "setting"}],
  "uptime": "..."
}
```

---

#### `table_stats`
Estatísticas de manutenção: dead tuples, vacuum status, bloat, contagem de scans.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `table` | string | não | Filtrar por tabela (mostra todas se omitido) |

**Retorno:** Array com `table_name, live_rows, dead_rows, dead_pct, last_vacuum, last_autovacuum, seq_scan, idx_scan`

---

#### `vacuum_table`
Executa VACUUM ANALYZE para recuperar linhas mortas e atualizar estatísticas.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `table` | string | sim | Tabela para vacuum |
| `full` | boolean | não | VACUUM FULL — trava a tabela e reescreve (padrão: false) |

**Retorno:** Mensagem de sucesso/erro

---

#### `running_queries`
Mostra queries em execução com duração, estado e wait events.

**Sem parâmetros.**

**Retorno:** Array com `pid, usename, application_name, state, wait_event_type, duration, query_snippet`

---

#### `kill_query`
Termina uma query em execução pelo PID.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `pid` | number | sim | PID do processo |

**Retorno:** Mensagem de sucesso/erro

---

#### `index_usage`
Análise de uso de índices: mais/menos usados, não usados, tamanhos.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `table` | string | não | Filtrar por tabela |

**Retorno:** `{indexes[], summary{total_indexes, unused_indexes, wasted_space}}`

---

### Financas (11 ferramentas)

#### `list_categories`
Lista categorias financeiras com filtros opcionais.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `type` | enum | não | `receita`, `despesa` ou `ambos` |
| `scope` | enum | não | `pessoal` ou `empresa` |
| `is_default` | boolean | não | Apenas categorias padrão |

**Retorno:** Array de categorias `{id, name, color, type, scope, is_default, created_at, updated_at}`

---

#### `create_category`
Cria uma nova categoria financeira.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `name` | string | sim | Nome da categoria |
| `type` | enum | sim | `receita`, `despesa` ou `ambos` |
| `scope` | enum | sim | `pessoal` ou `empresa` |
| `color` | string | não | Cor hex (padrão: `#818cf8`) |
| `is_default` | boolean | não | Marcar como padrão (padrão: false) |

**Retorno:** Categoria criada

---

#### `update_category`
Atualiza uma categoria existente. Apenas campos informados são atualizados.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `id` | string (uuid) | sim | UUID da categoria |
| `name` | string | não | Novo nome |
| `type` | enum | não | Novo tipo |
| `scope` | enum | não | Novo scope |
| `color` | string | não | Nova cor hex |
| `is_default` | boolean | não | Definir como padrão |

**Retorno:** Categoria atualizada

---

#### `delete_category`
Remove uma categoria. Falha se houver transações vinculadas.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `id` | string (uuid) | sim | UUID da categoria |

**Retorno:** Mensagem de sucesso/erro

---

#### `search_transactions`
Busca transações com filtros combinados. Inclui nome e cor da categoria.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `search` | string | não | Busca na descrição (ILIKE) |
| `type` | enum | não | `receita` ou `despesa` |
| `scope` | enum | não | `pessoal` ou `empresa` |
| `category_id` | string (uuid) | não | Filtrar por categoria |
| `date_from` | string | não | Data inicial (YYYY-MM-DD) |
| `date_to` | string | não | Data final (YYYY-MM-DD) |
| `is_paid` | boolean | não | Status de pagamento |
| `transaction_kind` | enum | não | `unica`, `parcelamento` ou `recorrente` |
| `limit` | number | não | Máximo de resultados (padrão: 50) |
| `offset` | number | não | Offset para paginação |

**Retorno:** `{total, rows[{id, type, scope, amount, description, date, is_paid, transaction_kind, group_id, installment_index, installment_total, frequency, category_name, category_color}]}`

---

#### `create_transaction`
Cria uma transação financeira. Para parcelamentos, gera automaticamente todas as parcelas com `group_id` compartilhado.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `type` | enum | sim | `receita` ou `despesa` |
| `scope` | enum | sim | `pessoal` ou `empresa` |
| `amount` | number | sim | Valor em centavos (inteiro) |
| `description` | string | sim | Descrição da transação |
| `category_id` | string (uuid) | sim | UUID da categoria |
| `date` | string | sim | Data (YYYY-MM-DD) |
| `is_paid` | boolean | não | Status de pagamento (padrão: true) |
| `transaction_kind` | enum | não | `unica`, `parcelamento` ou `recorrente` (padrão: `unica`) |
| `installment_total` | number | não | Número de parcelas (para parcelamento) |
| `frequency` | enum | não | `mensal`, `semanal` ou `anual` |

**Retorno:** Transação criada (ou `{installments_created, rows[]}` para parcelamentos)

---

#### `update_transaction`
Atualiza uma transação existente. Apenas campos informados são atualizados.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `id` | string (uuid) | sim | UUID da transação |
| `type` | enum | não | Novo tipo |
| `scope` | enum | não | Novo scope |
| `amount` | number | não | Novo valor em centavos |
| `description` | string | não | Nova descrição |
| `category_id` | string (uuid) | não | Nova categoria |
| `date` | string | não | Nova data (YYYY-MM-DD) |
| `is_paid` | boolean | não | Status de pagamento |

**Retorno:** Transação atualizada

---

#### `delete_transaction`
Remove uma transação. Opcionalmente remove todas as parcelas do mesmo grupo.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `id` | string (uuid) | sim | UUID da transação |
| `delete_group` | boolean | não | Deletar todas as parcelas do grupo (padrão: false) |

**Retorno:** Mensagem de sucesso/erro

---

#### `financial_summary`
Resumo financeiro: total de receitas vs despesas, saldo e breakdown por categoria.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `date_from` | string | não | Data inicial (YYYY-MM-DD) |
| `date_to` | string | não | Data final (YYYY-MM-DD) |
| `scope` | enum | não | `pessoal` ou `empresa` |
| `is_paid` | boolean | não | Apenas pagas/não pagas |

**Retorno:**
```json
{
  "summary": {
    "total_receitas": "500000",
    "total_despesas": "350000",
    "saldo": "150000",
    "total_transactions": "45"
  },
  "by_category": [
    {"category": "Energia", "color": "#818cf8", "type": "despesa", "total": "120000", "count": "12"},
    ...
  ]
}
```

---

#### `cashflow_report`
Fluxo de caixa mensal: receitas, despesas e saldo por mês.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `year` | number | não | Ano (padrão: ano atual) |
| `scope` | enum | não | `pessoal` ou `empresa` |
| `is_paid` | boolean | não | Apenas pagas/não pagas |

**Retorno:**
```json
[
  {"month": "2026-01", "receitas": "250000", "despesas": "180000", "saldo": "70000", "transactions": "15"},
  {"month": "2026-02", "receitas": "250000", "despesas": "170000", "saldo": "80000", "transactions": "12"},
  ...
]
```

---

#### `category_breakdown`
Breakdown de gastos ou receitas por categoria em um período. Mostra total, percentual e contagem.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `type` | enum | não | `receita` ou `despesa` (padrão: `despesa`) |
| `date_from` | string | não | Data inicial (YYYY-MM-DD) |
| `date_to` | string | não | Data final (YYYY-MM-DD) |
| `scope` | enum | não | `pessoal` ou `empresa` |
| `is_paid` | boolean | não | Apenas pagas/não pagas |

**Retorno:**
```json
{
  "type": "despesa",
  "grand_total": 10862888,
  "categories": [
    {"category": "Financiamento Casa", "color": "#818cf8", "total": "8566535", "count": "14", "percentage": "78.86"},
    {"category": "Energia", "color": "#818cf8", "total": "1316087", "count": "28", "percentage": "12.12"},
    ...
  ]
}
```

---

## Modelo de Dados

### Diagrama de Relacionamentos

```
categories (Categorias Financeiras)
    │
    └── 1:N → transactions (Transações)
                  ├── group_id (agrupa parcelas)
                  ├── installment_index / installment_total
                  └── frequency (recorrência)
```

### Tabelas

| Tabela | Descrição | Linhas |
|--------|-----------|--------|
| `categories` | Categorias financeiras (receita/despesa) | 14 |
| `transactions` | Transações financeiras | 110 |

### Enums

| Enum | Valores |
|------|---------|
| `category_type` | `receita`, `despesa`, `ambos` |
| `transaction_type` | `receita`, `despesa` |
| `scope` | `pessoal`, `empresa` |
| `transaction_kind` | `unica`, `parcelamento`, `recorrente` |
| `frequency` | `mensal`, `semanal`, `anual` |

### Schema Detalhado

**categories:**

| Coluna | Tipo | Nullable | Default |
|--------|------|----------|---------|
| `id` | uuid | NO | `gen_random_uuid()` |
| `name` | varchar | NO | |
| `color` | varchar | NO | `#818cf8` |
| `type` | category_type | NO | |
| `is_default` | boolean | NO | `false` |
| `scope` | scope | NO | |
| `created_at` | timestamptz | NO | `now()` |
| `updated_at` | timestamptz | NO | `now()` |

**transactions:**

| Coluna | Tipo | Nullable | Default |
|--------|------|----------|---------|
| `id` | uuid | NO | `gen_random_uuid()` |
| `type` | transaction_type | NO | |
| `scope` | scope | NO | |
| `amount` | bigint | NO | |
| `description` | text | NO | |
| `category_id` | uuid (FK → categories.id) | NO | |
| `date` | date | NO | |
| `is_paid` | boolean | NO | `true` |
| `transaction_kind` | transaction_kind | NO | `unica` |
| `group_id` | uuid | YES | |
| `installment_index` | integer | YES | |
| `installment_total` | integer | YES | |
| `frequency` | frequency | YES | |
| `created_at` | timestamptz | NO | `now()` |
| `updated_at` | timestamptz | NO | `now()` |

---

## Deploy

### Infraestrutura

- **Orquestração:** Docker Swarm
- **Proxy reverso:** Traefik 2.11 (HTTPS automático via Let's Encrypt)
- **Rede:** `network_public` (overlay)
- **Stack name:** `mcp-financas`

### Deploy Inicial

```bash
cd /root/mcp-financas
docker build -t mcp-financas .
docker stack deploy -c docker-compose.yml mcp-financas
```

### Atualização

```bash
cd /root/mcp-financas
docker build -t mcp-financas:latest .
docker service update --force mcp-financas_mcp-financas
```

> `--force` é necessário porque a tag `latest` não muda — o Swarm não detectaria a atualização sem ele.

### Verificação

```bash
# Status do serviço
docker service ls --filter name=mcp-financas

# Logs
docker service logs mcp-financas_mcp-financas -f

# Health check
curl https://mcp-financas-postgres.famachat.com.br/health
```

---

## Configuração do Cliente MCP

### Dados de Conexão

| Item | Valor |
|------|-------|
| **URL** | `https://mcp-financas-postgres.famachat.com.br/mcp` |
| **Transporte** | Streamable HTTP (stateless) |
| **Autenticação** | Bearer Token |
| **Header** | `Authorization: Bearer <API_KEY>` |

### Claude Desktop

No arquivo de configuração do Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "financas": {
      "url": "https://mcp-financas-postgres.famachat.com.br/mcp",
      "headers": {
        "Authorization": "Bearer <API_KEY>"
      }
    }
  }
}
```

### Cursor

Nas configurações do Cursor, adicione um MCP server com:

- **Type:** HTTP
- **URL:** `https://mcp-financas-postgres.famachat.com.br/mcp`
- **Headers:** `Authorization: Bearer <API_KEY>`

### Teste via cURL

```bash
# Health check
curl https://mcp-financas-postgres.famachat.com.br/health

# Listar tabelas
curl -X POST https://mcp-financas-postgres.famachat.com.br/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "list_tables",
      "arguments": {}
    },
    "id": 1
  }'
```

---

## Monitoramento

### Health Check

**URL:** `https://mcp-financas-postgres.famachat.com.br/health`

O Docker Swarm verifica automaticamente a cada 30 segundos. Se o health check falhar 3 vezes consecutivas, o container é reiniciado.

### Logs

```bash
# Logs em tempo real
docker service logs mcp-financas_mcp-financas -f

# Últimas 50 linhas
docker service logs mcp-financas_mcp-financas --tail 50
```

Formato dos logs:
```
[2026-03-25T16:05:50.065Z] POST /mcp 200 45ms - 10.0.0.2
```

### Recursos do Container

| Recurso | Limite |
|---------|--------|
| CPU | 1 core |
| Memória | 1 GB |
| Restart | Automático (max 3 tentativas em 120s) |
