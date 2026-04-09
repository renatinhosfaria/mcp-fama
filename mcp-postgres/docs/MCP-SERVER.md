# MCP PostgreSQL Server — CRM Imobiliário

Servidor MCP (Model Context Protocol) que conecta agentes de IA ao banco de dados PostgreSQL do CRM Imobiliário da Fama Negócios Imobiliários, expondo 40 ferramentas e 2 recursos para consulta, análise e gestão de dados.

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
   - [Clientes (7)](#clientes-7-ferramentas)
   - [Leads (6)](#leads-6-ferramentas)
   - [Imóveis (5)](#imóveis-5-ferramentas)
   - [Tasks (4)](#tasks-4-ferramentas)
   - [Sistema (6)](#sistema-6-ferramentas)
8. [Modelo de Dados](#modelo-de-dados)
9. [Deploy](#deploy)
10. [Configuração do Cliente MCP](#configuração-do-cliente-mcp)
11. [Monitoramento](#monitoramento)

---

## Visão Geral

| Item | Detalhe |
|------|---------|
| **Nome** | `postgres-neondb` |
| **Versão** | 1.0.0 |
| **Protocolo** | MCP (Model Context Protocol) |
| **Transporte** | Streamable HTTP |
| **URL de Produção** | `https://mcp-famachat-postgres.famachat.com.br/mcp` |
| **Banco de Dados** | PostgreSQL 17 (pgvector) |
| **Ferramentas** | 40 |
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
              │   (Let's Encrypt)│   mcp-famachat-postgres.famachat.com.br
              └────────┬────────┘
                       │ network_public (overlay)
                       ▼
              ┌─────────────────┐
              │  MCP Server      │   Node.js (porta 3100)
              │  (Express)       │
              │                  │
              │  ┌────────────┐  │
              │  │  Helmet     │  │   Headers de segurança
              │  ├────────────┤  │
              │  │  Logger     │  │   Log de requisições
              │  ├────────────┤  │
              │  │ Rate Limit  │  │   60 req/min
              │  ├────────────┤  │
              │  │  Auth       │  │   Bearer Token
              │  ├────────────┤  │
              │  │ MCP Handler │  │   40 tools + 2 resources
              │  └────────────┘  │
              └────────┬────────┘
                       │ network_public (overlay)
                       ▼
              ┌─────────────────┐
              │   PostgreSQL 17  │   pgvector
              │  (postgres_      │   porta 5432
              │   postgres)      │   Database: neondb
              └─────────────────┘
```

### Fluxo de Sessão MCP

1. Cliente envia `POST /mcp` com request `initialize` (sem `mcp-session-id`)
2. Servidor cria nova sessão com UUID e retorna `mcp-session-id` no header
3. Requisições subsequentes incluem `mcp-session-id` no header
4. Cliente pode abrir stream SSE via `GET /mcp` para notificações
5. Cliente encerra sessão via `DELETE /mcp`

As sessões são armazenadas em memória — um reinício do container encerra todas as sessões ativas. Clientes MCP reconectam automaticamente.

---

## Configuração

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `DATABASE_URL` | String de conexão PostgreSQL | **obrigatório** |
| `API_KEY` | Token Bearer para autenticação | **obrigatório** |
| `PORT` | Porta do servidor HTTP | `3100` |
| `DB_POOL_MAX` | Máximo de conexões no pool | `10` |
| `QUERY_TIMEOUT_MS` | Timeout de queries (ms) | `30000` |
| `RATE_LIMIT_RPM` | Requisições por minuto | `60` |
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
- **Rate Limiting** — 60 requisições/minuto por IP (configurável)
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
  "timestamp": "2026-03-17T15:09:28.894Z"
}
```

**Resposta (503):** Banco de dados desconectado.

### `POST /mcp`

Endpoint principal do MCP. Recebe requisições JSON-RPC 2.0.

- **Sem `mcp-session-id`:** Aceita apenas `initialize` — cria nova sessão
- **Com `mcp-session-id`:** Encaminha para sessão existente

**Headers obrigatórios:**
```
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <API_KEY>
```

### `GET /mcp`

Stream SSE (Server-Sent Events) para notificações do servidor.

**Header obrigatório:** `mcp-session-id`

### `DELETE /mcp`

Encerra uma sessão MCP.

**Header obrigatório:** `mcp-session-id`

---

## Recursos MCP

### `postgres://schema`

Esquema completo do banco de dados: tabelas, colunas, tipos, relacionamentos e enums.

**Retorno:**
```json
{
  "tables": {
    "clientes": [
      {"column_name": "id", "data_type": "integer", "is_nullable": "NO", ...},
      ...
    ],
    ...
  },
  "foreign_keys": [
    {"source_table": "clientes", "source_column": "broker_id", "target_table": "sistema_users", "target_column": "id"},
    ...
  ],
  "enums": [
    {"enum_name": "...", "values": ["...", "..."]},
    ...
  ]
}
```

### `postgres://stats`

Dashboard de saúde do banco: cache, conexões, bloat, vacuum.

**Retorno:**
```json
{
  "health": {
    "db_size": "256 MB",
    "cache_hit_pct": "99.85",
    "connections": 5,
    "commits": 150000,
    "rollbacks": 12
  },
  "top_bloat_tables": [
    {"relname": "clientes", "n_live_tup": 5000, "n_dead_tup": 120, "dead_pct": "2.34", ...},
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

### Clientes (7 ferramentas)

#### `search_clients`
Busca clientes por nome, email, telefone ou CPF. Suporta filtros por status, fonte, corretor e WhatsApp.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `search` | string | não | Termo de busca (ILIKE em full_name, email, phone, cpf) |
| `status` | string | não | Filtrar por status |
| `source` | string | não | Filtrar por fonte do lead |
| `broker_id` | number | não | Filtrar por corretor (sistema_users.id) |
| `has_whatsapp` | boolean | não | Filtrar por disponibilidade de WhatsApp |
| `limit` | number | não | Máximo de resultados (padrão: 20) |
| `offset` | number | não | Offset para paginação |

**Retorno:** `{count, clients[]}`

---

#### `get_client`
Detalhes completos de um cliente: perfil, corretor, últimas 10 anotações, agendamentos, vendas, visitas e contagem de leads.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `client_id` | number | sim | ID do cliente |

**Retorno:** `{client, notes[], appointments[], sales[], visits[], leads_count}`

---

#### `client_timeline`
Timeline unificada de todos os eventos de um cliente (anotações, agendamentos, visitas, vendas), ordenada por data.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `client_id` | number | sim | ID do cliente |
| `limit` | number | não | Máximo de eventos (padrão: 50) |

**Retorno:** `{client_id, events[{event_type, event_id, description, event_date, user_name}]}`

---

#### `add_client_note`
Adiciona uma anotação a um cliente.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `client_id` | number | sim | ID do cliente |
| `user_id` | number | sim | ID do autor (sistema_users.id) |
| `text` | string | sim | Conteúdo da anotação |

**Retorno:** `{success: true, note{id, cliente_id, user_id, text, created_at}}`

---

#### `list_appointments`
Lista agendamentos com filtros flexíveis: cliente, corretor, status, tipo, data, somente futuros.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `client_id` | number | não | Filtrar por cliente |
| `broker_id` | number | não | Filtrar por corretor |
| `status` | string | não | Filtrar por status |
| `type` | string | não | Filtrar por tipo |
| `upcoming_only` | boolean | não | Apenas futuros (padrão: false) |
| `date_from` | string | não | Data inicial (ISO) |
| `date_to` | string | não | Data final (ISO) |
| `limit` | number | não | Máximo de resultados (padrão: 50) |

**Retorno:** `{count, appointments[]}`

---

#### `client_stats`
Estatísticas agregadas de clientes: contagem por status, por fonte e por corretor.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `broker_id` | number | não | Filtrar por corretor |
| `period` | string | não | Período (ex: "30d", "90d", "1y") |

**Retorno:** `{by_status[], by_source[], by_broker[]}`

---

#### `sales_report`
Relatório de vendas: valor total, comissão e comissão total agrupados por corretor.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `broker_id` | number | não | Filtrar por corretor |
| `date_from` | string | não | Data inicial (ISO, baseado em sold_at) |
| `date_to` | string | não | Data final (ISO, baseado em sold_at) |

**Retorno:** `{by_broker[], totals{total_sales, grand_total_value, grand_total_commission}}`

---

### Leads (6 ferramentas)

#### `search_leads`
Busca leads por nome, email ou telefone. Filtros por status, fonte, corretor e score mínimo.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `search` | string | não | Termo de busca (ILIKE em full_name, email, phone) |
| `status` | string | não | Filtrar por status |
| `source` | string | não | Filtrar por fonte |
| `broker_id` | number | não | Filtrar por corretor |
| `min_score` | number | não | Score mínimo |
| `limit` | number | não | Máximo de resultados (padrão: 20) |
| `offset` | number | não | Offset para paginação |

**Retorno:** `{count, leads[]}`

---

#### `get_lead`
Detalhes completos de um lead: perfil, corretor, cliente associado, entradas SLA cascata ativas e últimos 10 logs de SLA.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `lead_id` | number | sim | ID do lead |

**Retorno:** `{lead, active_sla_cascata[], recent_sla_logs[]}`

---

#### `lead_pipeline`
Visão geral do pipeline: contagem de leads agrupados por status.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `broker_id` | number | não | Filtrar por corretor |
| `source` | string | não | Filtrar por fonte |

**Retorno:** `{total, pipeline[{status, count}]}`

---

#### `sla_status`
Entradas SLA cascata ativas com tempo restante até o prazo.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `broker_id` | number | não | Filtrar por corretor (usuario_id) |
| `expiring_within_hours` | number | não | Mostrar SLAs expirando em X horas |
| `limit` | number | não | Máximo de resultados (padrão: 50) |

**Retorno:** `{count, sla_entries[{..., hours_remaining, urgency}]}`

Níveis de urgência: `EXPIRED`, `CRITICAL` (<4h), `WARNING` (<12h), `OK`

---

#### `sla_expiring`
SLAs expirando dentro de X horas (padrão: 4).

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `hours` | number | não | Horas para expiração (padrão: 4) |
| `broker_id` | number | não | Filtrar por corretor |

**Retorno:** `{hours_threshold, count, expiring_slas[]}`

---

#### `lead_sources`
Análise de fontes de leads: contagem e score médio por fonte.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `date_from` | string | não | Data inicial (ISO) |
| `date_to` | string | não | Data final (ISO) |

**Retorno:** `{total_leads, sources[{source, count, avg_score, earliest, latest}]}`

---

### Imóveis (5 ferramentas)

#### `search_properties`
Busca empreendimentos por nome, bairro ou cidade. Filtros por tipo, faixa de preço, cidade, bairro e zona.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `search` | string | não | Termo de busca (ILIKE em nome, bairro, cidade) |
| `property_type` | string | não | Filtrar por tipo_imovel |
| `min_price` | number | não | Preço mínimo |
| `max_price` | number | não | Preço máximo |
| `city` | string | não | Filtrar por cidade |
| `neighborhood` | string | não | Filtrar por bairro |
| `zone` | string | não | Filtrar por zona |
| `limit` | number | não | Máximo de resultados (padrão: 20) |
| `offset` | number | não | Offset para paginação |

**Retorno:** `{count, properties[{..., apartment_count, min_price, max_price, avg_price}]}`

---

#### `get_property`
Detalhes completos de um empreendimento: dados, apartamentos, construtora e contatos.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `property_id` | number | sim | id_empreendimento |

**Retorno:** `{property, apartments[], construtora_contacts[]}`

---

#### `property_availability`
Lista apartamentos disponíveis com filtros por status, quartos mínimos e preço máximo.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `property_id` | number | não | Filtrar por empreendimento |
| `status` | string | não | Status do apartamento (padrão: `disponivel`) |
| `min_rooms` | number | não | Mínimo de quartos |
| `max_price` | number | não | Preço máximo |

**Retorno:** `{count, apartments[]}`

---

#### `search_apartments`
Busca apartamentos diretamente com filtros por quartos, área, preço e status. Inclui dados de localização do empreendimento.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `rooms` | number | não | Número exato de quartos |
| `min_area` | number | não | Área privativa mínima |
| `max_price` | number | não | Preço máximo |
| `status` | string | não | Status do apartamento |
| `limit` | number | não | Máximo de resultados (padrão: 20) |
| `offset` | number | não | Offset para paginação |

**Retorno:** `{count, apartments[]}`

---

#### `property_price_analysis`
Estatísticas de preço (min, max, média) agrupadas por bairro e zona. Inclui preço médio por m².

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `neighborhood` | string | não | Filtrar por bairro |
| `zone` | string | não | Filtrar por zona |

**Retorno:** `{analysis[{neighborhood, zone, property_count, apartment_count, min_price, max_price, avg_price, avg_area, avg_price_per_sqm}]}`

---

### Tasks (4 ferramentas)

#### `get_board`
Retorna um board de tarefas com listas e contagem de cards. Se nenhum board_id for informado, retorna o primeiro board ativo.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `board_id` | number | não | ID do board (padrão: primeiro board ativo) |

**Retorno:** `{board, lists[{id, name, position, color, card_count}], stats{total_cards, completed, overdue}}`

---

#### `list_tasks`
Lista cards de tarefas com filtros por board, lista, responsável, prioridade e status de arquivo.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `board_id` | number | não | Filtrar por board |
| `list_id` | number | não | Filtrar por lista |
| `assigned_to` | number | não | Filtrar por responsável |
| `priority` | string | não | Filtrar por prioridade (low, medium, high, urgent) |
| `is_archived` | boolean | não | Incluir arquivados (padrão: false) |
| `limit` | number | não | Máximo de resultados (padrão: 50) |
| `offset` | number | não | Offset para paginação |

**Retorno:** `{count, tasks[]}`

---

#### `create_task`
Cria um novo card de tarefa em uma lista.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `list_id` | number | sim | ID da lista |
| `title` | string | sim | Título do card |
| `description` | string | não | Descrição |
| `priority` | enum | não | low, medium, high, urgent (padrão: medium) |
| `assigned_to` | number | não | ID do responsável |
| `due_date` | string | não | Data de vencimento (ISO 8601) |
| `tags` | string[] | não | Array de tags |
| `estimated_hours` | number | não | Horas estimadas |

**Retorno:** `{created{...card}}`

---

#### `update_task`
Atualiza um card. Apenas campos informados são atualizados (SET dinâmico).

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `card_id` | number | sim | ID do card |
| `title` | string | não | Novo título |
| `description` | string | não | Nova descrição |
| `priority` | enum | não | Nova prioridade |
| `list_id` | number | não | Mover para outra lista |
| `assigned_to` | number | não | Novo responsável |
| `due_date` | string | não | Nova data de vencimento |
| `is_archived` | boolean | não | Arquivar/desarquivar |
| `completed_at` | string | não | Timestamp de conclusão (string vazia para limpar) |
| `tags` | string[] | não | Substituir tags |
| `estimated_hours` | number | não | Horas estimadas |
| `actual_hours` | number | não | Horas reais |

**Retorno:** `{updated{...card}}`

---

### Sistema (6 ferramentas)

#### `list_users`
Lista todos os usuários do sistema. Exclui `password_hash` dos resultados.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `role` | string | não | Filtrar por role |
| `department` | string | não | Filtrar por departamento |
| `is_active` | boolean | não | Filtrar por status ativo |

**Retorno:** `{count, users[{id, username, full_name, email, phone, role, department, is_active, whatsapp_instance, whatsapp_connected, last_login_at, created_at}]}`

---

#### `broker_performance`
Métricas de desempenho dos corretores: clientes, leads, vendas, valor total, taxa de conversão e agendamentos.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `broker_id` | number | não | Filtrar por corretor |
| `period` | enum | não | 30d, 90d, 1y (padrão: 30d) |

**Retorno:** `{period, brokers[{broker_id, broker_name, total_clients, total_leads, total_sales, total_sale_value, conversion_rate, appointments_count}]}`

---

#### `user_schedule`
Horários de trabalho de um usuário.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `user_id` | number | sim | ID do usuário |

**Retorno:** `{user_id, user_name, schedule[{day, start_time, end_time, full_day}]}`

---

#### `daily_report`
Relatório diário: novos leads, novos clientes, vendas, agendamentos e SLAs expirando.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `date` | string | não | Data (YYYY-MM-DD, padrão: hoje) |
| `broker_id` | number | não | Filtrar por corretor |

**Retorno:** `{date, broker_id, new_leads, new_clients, total_sales, total_sales_value, appointments_count, sla_expirations}`

---

#### `notifications`
Notificações de um usuário.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `user_id` | number | sim | ID do usuário |
| `unread_only` | boolean | não | Apenas não lidas (padrão: false) |
| `limit` | number | não | Máximo de resultados (padrão: 20) |

**Retorno:** `{count, notifications[{id, type, priority, title, message, event_type, entity_type, entity_id, metadata, is_read, read_at, created_at}]}`

---

#### `whatsapp_status`
Status de todas as instâncias WhatsApp com informações do usuário associado.

**Sem parâmetros.**

**Retorno:** `{count, instances[{instancia_id, instance_name, status, last_connection, webhook, user_id, user_name, user_email}]}`

---

## Modelo de Dados

### Diagrama de Relacionamentos

```
sistema_users (Usuários/Corretores)
    │
    ├── 1:N → clientes (broker_id)
    │           ├── 1:N → clientes_id_anotacoes (Anotações)
    │           ├── 1:N → clientes_agendamentos (Agendamentos)
    │           ├── 1:N → clientes_vendas (Vendas)
    │           └── 1:N → clientes_visitas (Visitas)
    │
    ├── 1:N → sistema_leads (Leads)
    │           ├── 1:N → sistema_leads_sla_cascata (SLA)
    │           └── 1:N → sistema_leads_sla_cascata_logs (SLA Logs)
    │
    ├── 1:N → sistema_users_horarios (Horários)
    ├── 1:N → sistema_notificacoes (Notificações)
    └── 1:1 → sistema_whatsapp_instances (WhatsApp)

imoveis_construtoras (Construtoras)
    ├── 1:N → imoveis_empreendimentos (Empreendimentos)
    │           └── 1:N → imoveis_apartamentos (Apartamentos)
    └── 1:N → imoveis_contatos_construtora (Contatos)

famatasks_boards (Boards)
    └── 1:N → famatasks_lists (Listas)
                └── 1:N → famatasks_cards (Cards/Tarefas)
```

### Tabelas Principais

| Tabela | Descrição |
|--------|-----------|
| `sistema_users` | Usuários do sistema (corretores, admins) |
| `sistema_users_horarios` | Horários de trabalho por dia da semana |
| `sistema_notificacoes` | Notificações do sistema |
| `sistema_whatsapp_instances` | Instâncias WhatsApp conectadas |
| `clientes` | Clientes do CRM |
| `clientes_id_anotacoes` | Anotações/notas dos clientes |
| `clientes_agendamentos` | Agendamentos (visitas, reuniões, etc.) |
| `clientes_vendas` | Registro de vendas |
| `clientes_visitas` | Registro de visitas a imóveis |
| `sistema_leads` | Leads (prospects) |
| `sistema_leads_sla_cascata` | Controle de SLA em cascata |
| `sistema_leads_sla_cascata_logs` | Logs de eventos do SLA |
| `imoveis_empreendimentos` | Empreendimentos imobiliários |
| `imoveis_apartamentos` | Unidades/apartamentos |
| `imoveis_construtoras` | Construtoras |
| `imoveis_contatos_construtora` | Contatos das construtoras |
| `famatasks_boards` | Boards de tarefas |
| `famatasks_lists` | Listas dentro dos boards |
| `famatasks_cards` | Cards/tarefas |

---

## Deploy

### Infraestrutura

- **VPS:** Contabo (`vmi1988871.contaboserver.net`)
- **Orquestração:** Docker Swarm
- **Proxy reverso:** Traefik 2.11 (HTTPS automático via Let's Encrypt)
- **Rede:** `network_public` (overlay)
- **Stack name:** `mcp-postgres`

### Deploy Inicial

```bash
cd /root/mcp-postgres
docker build -t mcp-postgres .
docker stack deploy -c docker-compose.yml mcp-postgres
```

### Atualização

```bash
cd /root/mcp-postgres
git pull
docker build -t mcp-postgres:latest .
docker service update --force mcp-postgres_mcp-postgres
```

> `--force` é necessário porque a tag `latest` não muda — o Swarm não detectaria a atualização sem ele.

### Verificação

```bash
# Status do serviço
docker service ls --filter name=mcp-postgres

# Logs
docker service logs mcp-postgres_mcp-postgres -f

# Health check
curl https://mcp-famachat-postgres.famachat.com.br/health
```

---

## Configuração do Cliente MCP

### Dados de Conexão

| Item | Valor |
|------|-------|
| **URL** | `https://mcp-famachat-postgres.famachat.com.br/mcp` |
| **Transporte** | Streamable HTTP |
| **Autenticação** | Bearer Token |
| **Header** | `Authorization: Bearer <API_KEY>` |

### Claude Desktop

No arquivo de configuração do Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "crm-imobiliario": {
      "url": "https://mcp-famachat-postgres.famachat.com.br/mcp",
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
- **URL:** `https://mcp-famachat-postgres.famachat.com.br/mcp`
- **Headers:** `Authorization: Bearer <API_KEY>`

### Teste via cURL

```bash
# Health check
curl https://mcp-famachat-postgres.famachat.com.br/health

# Initialize (teste de conexão)
curl -X POST https://mcp-famachat-postgres.famachat.com.br/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1.0"}
    },
    "id": 1
  }'
```

---

## Monitoramento

### Health Check

**URL:** `https://mcp-famachat-postgres.famachat.com.br/health`

O Docker Swarm verifica automaticamente a cada 30 segundos. Se o health check falhar 3 vezes consecutivas, o container é reiniciado.

### Logs

```bash
# Logs em tempo real
docker service logs mcp-postgres_mcp-postgres -f

# Últimas 50 linhas
docker service logs mcp-postgres_mcp-postgres --tail 50
```

Formato dos logs:
```
[2026-03-17T15:09:28.894Z] POST /mcp 200 45ms - 10.0.0.2
```

### Portainer

Interface visual disponível na VPS para gerenciamento de containers, logs e métricas.

### Recursos do Container

| Recurso | Limite |
|---------|--------|
| CPU | 1 core |
| Memória | 1 GB |
| Restart | Automático (max 3 tentativas em 120s) |
