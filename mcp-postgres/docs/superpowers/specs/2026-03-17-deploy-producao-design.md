# Deploy em Produção — MCP PostgreSQL Server

## Contexto

O `mcp-postgres-neondb` é um servidor MCP (Model Context Protocol) que expõe 40 ferramentas para um CRM Imobiliário via PostgreSQL. Precisa ser deployado em produção na VPS existente (`vmi1988871`) para acesso externo via HTTPS.

## Decisões

| Item | Decisão |
|------|---------|
| Infra | VPS existente, Docker Swarm |
| Proxy/SSL | Traefik 2.11 + Let's Encrypt (já em execução) |
| Subdomínio | `mcp-famachat-postgres.famachat.com.br` |
| Rede Swarm | `network_public` (overlay) |
| Conexão DB | `postgres_postgres:5432` via rede interna do Swarm |
| Arquivos novos | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.gitignore` |
| Comando de deploy | `docker stack deploy -c docker-compose.yml mcp-postgres` |

## Arquitetura

```
Cliente MCP (Claude Desktop, Cursor, etc.)
        │
        ▼ HTTPS (443)
   ┌──────────┐
   │  Traefik  │  mcp-famachat-postgres.famachat.com.br → mcp-postgres:3100
   └──────────┘
        │ network_public (overlay)
        ▼
   ┌──────────────────┐
   │  mcp-postgres     │  Node.js (porta 3100)
   │  (container)      │  Express + MCP SDK
   └──────────────────┘
        │ network_public (overlay)
        ▼
   ┌──────────────────┐
   │ postgres_postgres │  PostgreSQL 17 (pgvector)
   │  (container)      │  porta 5432
   └──────────────────┘
```

## Arquivos a Criar

### 1. Dockerfile

Build multi-stage para imagem leve:

- **Stage 1 (build):** `node:20-alpine`, instala todas as dependências, compila TypeScript (`npm run build`)
- **Stage 2 (produção):** `node:20-alpine`, copia apenas `dist/` e `node_modules` de produção
- **CMD:** `node dist/index.js` (executa o JS compilado, não `tsx`)
- Usuário não-root (`node`)
- Porta exposta: 3100

### 2. docker-compose.yml

Stack Swarm com:

- **Serviço:** `mcp-postgres`
- **Imagem:** `mcp-postgres:latest` (somente `image:`, sem `build:` — Docker Swarm não suporta `build` em `docker stack deploy`)
- **Rede:** `network_public` (external)
- **Labels Traefik:**
  - `traefik.enable=true`
  - `traefik.docker.network=network_public`
  - `` traefik.http.routers.mcp_postgres.rule=Host(`mcp-famachat-postgres.famachat.com.br`) ``
  - `traefik.http.routers.mcp_postgres.entrypoints=websecure`
  - `traefik.http.routers.mcp_postgres.tls=true`
  - `traefik.http.routers.mcp_postgres.tls.certresolver=letsencryptresolver`
  - `traefik.http.services.mcp_postgres.loadbalancer.server.port=3100`
- **Variáveis de ambiente:** valores definidos diretamente no compose (mesmo padrão do n8n e outros stacks). As credenciais (`DATABASE_URL`, `API_KEY`) ficam no arquivo docker-compose.yml na VPS — não são commitadas no repositório git.
  - `DATABASE_URL` — conexão via rede interna do Swarm (`postgres_postgres:5432`), sem `sslmode` (comunicação interna na overlay network, SSL desnecessário)
  - `API_KEY` — token Bearer para autenticação
  - `PORT=3100`
  - `DB_POOL_MAX=10`
  - `QUERY_TIMEOUT_MS=30000`
  - `RATE_LIMIT_RPM=60`
  - `NODE_ENV=production`
- **Deploy:**
  - Constraint: `node.role == manager`
  - Limites de recursos: 1 CPU, 1GB memória (margem para 40 tools + pool de conexões)
  - Restart policy: `condition: on-failure`, `delay: 5s`, `max_attempts: 3`, `window: 120s`
- **Healthcheck:** `wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1` (Alpine não inclui `curl`, mas `wget` está disponível)

### 3. .dockerignore

```
node_modules
dist
.env
.git
.claude
docs
*.md
```

### 4. .gitignore

```
node_modules/
dist/
.env
docker-compose.yml
```

> **Nota:** `docker-compose.yml` está no `.gitignore` porque contém credenciais de produção. O arquivo é mantido apenas na VPS.

## Alterações no Código

### Rate limiter — excluir `/health`

O health check do Swarm faz requests frequentes ao `/health`. O rate limiter atual (60 req/min) pode causar falsos positivos no health check. Mover a rota `/health` para antes do middleware de rate limiting, ou excluí-la no rate limiter.

### Graceful shutdown

Adicionar handler de `SIGTERM`/`SIGINT` para desligamento gracioso:
- Fechar o servidor HTTP (parar de aceitar novas conexões)
- Drenar o pool de conexões do PostgreSQL (`pool.end()`)

## Limitações Conhecidas

### Sessões em memória

O servidor armazena sessões MCP em memória (`const transports: Record<string, ...>`). Quando o container reinicia, todas as sessões ativas são perdidas. Isso é aceitável para o uso atual — clientes MCP reconectam automaticamente criando uma nova sessão. Não há necessidade de persistência de sessão neste cenário.

## Segurança

- **HTTPS** automático via Traefik + Let's Encrypt
- **Autenticação** via Bearer token (API_KEY) em todas as rotas exceto `/health`
- **Rate limiting** a 60 req/min (express-rate-limit), excluindo `/health`
- **Helmet** para headers de segurança
- **Usuário não-root** no container
- **Comunicação interna** entre containers via rede overlay (sem exposição de portas)
- **Credenciais** não são commitadas no git (docker-compose.yml no .gitignore)

## Deploy

### Deploy inicial

```bash
cd /root/mcp-postgres
docker build -t mcp-postgres .
docker stack deploy -c docker-compose.yml mcp-postgres
```

Verificar:
```bash
docker service ls --filter name=mcp-postgres
docker service logs mcp-postgres_mcp-postgres
curl https://mcp-famachat-postgres.famachat.com.br/health
```

### Atualização

```bash
cd /root/mcp-postgres
git pull
docker build -t mcp-postgres:latest .
docker service update --force mcp-postgres_mcp-postgres
```

> **Nota:** `docker service update --force` é necessário porque a tag `latest` não muda — o Swarm não detectaria a atualização sem o `--force`.

## Monitoramento

- **Health check:** `https://mcp-famachat-postgres.famachat.com.br/health`
- **Logs:** `docker service logs mcp-postgres_mcp-postgres -f`
- **Portainer:** interface visual já disponível na VPS

## Configuração do Cliente MCP

Para conectar o Claude Desktop ou outro cliente MCP:

- **URL:** `https://mcp-famachat-postgres.famachat.com.br/mcp`
- **Header:** `Authorization: Bearer <API_KEY configurada no docker-compose.yml>`
- **Transporte:** Streamable HTTP
