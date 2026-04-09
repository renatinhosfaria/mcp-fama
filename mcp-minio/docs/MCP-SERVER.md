# MCP MinIO Server

Servidor MCP (Model Context Protocol) para acesso completo ao MinIO / S3-compatible object storage.

## Arquitetura

```
Cliente MCP (Claude, Cursor, etc.)
        │  Bearer Token
        ▼
  [Traefik HTTPS]
        │
        ▼
  [Express + MCP SDK]  ← stateless: cada request = novo server
        │
        ▼
  [MinIO SDK]
        │
        ▼
  MinIO S3 (s3.famachat.com.br)
```

## Configuração

| Variável            | Padrão                            | Descrição                          |
|---------------------|-----------------------------------|------------------------------------|
| `MINIO_ENDPOINT`    | `s3.famachat.com.br`             | Host do servidor MinIO             |
| `MINIO_PORT`        | `443`                             | Porta (9000 para HTTP local)       |
| `MINIO_USE_SSL`     | `true`                            | HTTPS habilitado                   |
| `MINIO_ACCESS_KEY`  | —                                 | Access key (obrigatório)           |
| `MINIO_SECRET_KEY`  | —                                 | Secret key (obrigatório)           |
| `MINIO_BUCKET_NAME` | `famaserver-files`                | Bucket padrão das tools            |
| `MINIO_REGION`      | `us-east-1`                       | Região S3                          |
| `MINIO_PUBLIC_URL`  | `https://s3.famachat.com.br`     | URL base para links públicos       |
| `MINIO_CONSOLE_URL` | `https://minio.famachat.com.br`  | URL do console MinIO               |
| `API_KEY`           | —                                 | Bearer token para autenticação     |
| `PORT`              | `3200`                            | Porta do servidor MCP              |
| `RATE_LIMIT_RPM`    | `300`                             | Requisições por minuto por IP      |

## Autenticação

Todas as requisições ao endpoint `/mcp` exigem Bearer token:

```
Authorization: Bearer <API_KEY>
```

## Endpoints

| Método | Rota      | Descrição                          |
|--------|-----------|------------------------------------|
| GET    | `/health` | Status do servidor e MinIO         |
| POST   | `/mcp`    | Endpoint MCP (stateless JSON)      |

## 30 Tools — 4 Categorias

### Buckets (10 tools)

| Tool                         | Descrição                                      |
|------------------------------|------------------------------------------------|
| `minio_list_buckets`         | Lista todos os buckets com data de criação     |
| `minio_bucket_exists`        | Verifica se um bucket existe                   |
| `minio_create_bucket`        | Cria um novo bucket                            |
| `minio_delete_bucket`        | Remove um bucket vazio                         |
| `minio_get_bucket_policy`    | Retorna política IAM do bucket (JSON)          |
| `minio_set_bucket_policy`    | Define política IAM do bucket                  |
| `minio_get_bucket_versioning`| Retorna configuração de versionamento          |
| `minio_set_bucket_versioning`| Ativa/suspende versionamento                   |
| `minio_get_bucket_tags`      | Retorna tags do bucket                         |
| `minio_set_bucket_tags`      | Define tags do bucket                          |

### Objetos (10 tools)

| Tool                       | Descrição                                        |
|----------------------------|--------------------------------------------------|
| `minio_list_objects`       | Lista objetos com prefixo, recursivo e paginação |
| `minio_get_object_info`    | Metadados: tamanho, etag, content-type           |
| `minio_delete_object`      | Remove um objeto                                 |
| `minio_delete_objects`     | Remove múltiplos objetos (bulk, até 1000)        |
| `minio_copy_object`        | Copia objeto entre buckets                       |
| `minio_move_object`        | Move objeto (copy + delete)                      |
| `minio_get_object_tags`    | Retorna tags de um objeto                        |
| `minio_set_object_tags`    | Define tags de um objeto                         |
| `minio_remove_object_tags` | Remove todas as tags de um objeto                |
| `minio_get_presigned_url`  | Gera URL pré-assinada (GET/PUT, até 7 dias)      |

### Transferências (4 tools)

| Tool                   | Descrição                                      |
|------------------------|------------------------------------------------|
| `minio_get_object_text`| Download de conteúdo como texto (UTF-8, 5MB)   |
| `minio_get_object_json`| Download e parse de arquivo JSON (5MB)         |
| `minio_put_object_text`| Upload de conteúdo texto                       |
| `minio_put_object_json`| Upload de objeto JSON serializado              |

### Admin (6 tools)

| Tool                            | Descrição                                      |
|---------------------------------|------------------------------------------------|
| `minio_server_info`             | Configuração e status de conectividade         |
| `minio_bucket_summary`          | Stats: contagem, tamanho total, por extensão   |
| `minio_search_objects`          | Busca objetos por padrão substring             |
| `minio_generate_public_url`     | Gera URL pública permanente do objeto          |
| `minio_list_incomplete_uploads` | Lista uploads multipart abandonados            |
| `minio_abort_incomplete_upload` | Aborta upload incompleto                       |

## 2 Resources

| URI               | Descrição                                          |
|-------------------|----------------------------------------------------|
| `minio://server`  | Configuração e status do servidor MinIO            |
| `minio://buckets` | Lista de buckets com contagem e tamanho total      |

## Deploy

### Build local

```bash
cd /root/mcp-minio
npm install
npm run build
```

### Docker

```bash
docker build -t mcp-minio:latest .
```

### Docker Swarm

```bash
docker stack deploy -c docker-compose.yml stack_mcp
```

### Teste rápido

```bash
# Health check
curl http://localhost:3200/health

# Listar buckets
curl -X POST http://localhost:3200/mcp \
  -H "Authorization: Bearer minio-mcp-2f8a1b3c-9d4e-4f7a-b2e5-1c6d8a9f0e3b" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"minio_list_buckets","arguments":{}}}'
```

## Configuração do Cliente MCP

```json
{
  "mcpServers": {
    "minio": {
      "url": "https://mcp-minio.famachat.com.br/mcp",
      "headers": {
        "Authorization": "Bearer minio-mcp-2f8a1b3c-9d4e-4f7a-b2e5-1c6d8a9f0e3b"
      }
    }
  }
}
```

## Segurança

- HTTPS via Traefik + Let's Encrypt
- Bearer token obrigatório em todas as rotas (exceto `/health`)
- Rate limiting: 300 req/min por IP
- Helmet (security headers)
- Container executa como usuário `node` (não root)
- Modo stateless: sem estado em memória entre requests
