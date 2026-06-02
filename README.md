# mcp-fama

Repositorio dos servidores MCP da Fama Chat e do plugin `mcp-fama` para Codex/Claude.

## Status atual

- Versao do plugin: `1.2.0`
- Branch principal: `main`
- Servidores publicados no plugin: Meta Ads, CRM/Postgres, MinIO e Obsidian
- Servidor `mcp-financas`: removido do plugin e do repositorio nesta versao

## Estrutura

| Caminho | Descricao |
|---|---|
| `meta-ads-mcp-server/` | Servidor MCP para Meta Ads, campanhas, anuncios, publicos, criativos, insights e conversoes. |
| `mcp-postgres/` | Servidor MCP para o CRM Imobiliario Fama Chat em PostgreSQL. |
| `mcp-minio/` | Servidor MCP para MinIO/S3, buckets, objetos, transferencias e administracao. |
| `mcp-obsidian/` | Servidor MCP para o vault Obsidian `fama-brain`, com Schema v1, sincronizacao git e memoria multiagente. |
| `.claude-plugin/` | Manifest do plugin para Claude. |
| `plugins/mcp-fama/` | Manifest, configuracao MCP e skill do plugin para Codex. |

## Servidores MCP

| Servidor | URL de producao | Token no cliente |
|---|---|---|
| `meta-ads` | `https://mcp-facebook-ads.famachat.com.br/mcp` | `META_ADS_API_KEY` |
| `crm-postgres` | `https://mcp-famachat-postgres.famachat.com.br/mcp` | `CRM_API_KEY` |
| `minio` | `https://mcp-minio.famachat.com.br/mcp` | `MINIO_API_KEY` |
| `obsidian` | `https://mcp-obsidian.famachat.com.br/mcp` | `OBSIDIAN_API_KEY` |

Os tokens sao lidos por variaveis de ambiente nos manifests do plugin. Nao coloque chaves reais em commits, exemplos ou logs.

## Desenvolvimento

Cada servidor e um projeto TypeScript independente.

```bash
cd meta-ads-mcp-server
npm install
npm run build
```

```bash
cd mcp-postgres
npm install
npm run build
npm test
```

```bash
cd mcp-minio
npm install
npm run build
```

```bash
cd mcp-obsidian
npm install
npm run build
npm test
```

## Documentacao por servidor

- `meta-ads-mcp-server/DOCUMENTATION.md`
- `mcp-postgres/docs/MCP-SERVER.md`
- `mcp-minio/docs/MCP-SERVER.md`
- `mcp-obsidian/README.md`

## Publicacao do plugin

O plugin Codex fica em `plugins/mcp-fama/`:

- `plugins/mcp-fama/.codex-plugin/plugin.json`
- `plugins/mcp-fama/.mcp.json`
- `plugins/mcp-fama/skills/mcp-fama/SKILL.md`

O manifest Claude fica em `.claude-plugin/plugin.json`.

Ao alterar servidores disponiveis, versao, descricoes ou variaveis de ambiente, mantenha esses manifests sincronizados com este README.
