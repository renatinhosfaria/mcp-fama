# MCP MinIO — Notas de Desenvolvimento

## Lições do mcp-postgres

- **Alpine containers**: usar `127.0.0.1` no healthcheck do Docker, não `localhost`
- **Restart policy**: usar `condition: any` para reiniciar inclusive em saídas normais (graceful shutdown)
- **Modo stateless**: cada request cria um novo McpServer + Transport — evita perda de sessão em redeploy
- **Testes**: acessar via `docker exec` para bypassar Traefik durante debug

## MinIO SDK Notes

- `listObjectsV2` usa EventEmitter — converter para Promise com `listObjectsAsync`
- `getObject` retorna `Readable` — usar `for await` para coletar buffer
- `copyObject` recebe path no formato `/${sourceBucket}/${sourceObject}`
- `removeObjects` aceita `string[]` ou `Array<{name: string, versionId?: string}>`
- `getBucketPolicy` lança `NoSuchBucketPolicy` quando bucket não tem política — tratar como null
- `pathStyle: true` necessário para MinIO (não AWS S3 padrão)

## Configuração de porta

- MinIO com SSL na porta 443: `MINIO_PORT=443` + `MINIO_USE_SSL=true`
- MCP server na porta 3200 (postgres usa 3100)

## Build

```bash
npm install
npm run build
docker build -t mcp-minio:latest .
docker stack deploy -c docker-compose.yml stack_minio
```
