import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minio, listObjectsAsync, formatBytes, healthCheck } from '../minio.js';
import { config } from '../config.js';

export function registerResources(server: McpServer): void {
  // ─── Resource: minio://server ─────────────────────────────────────────────
  server.registerResource(
    'minio-server',
    'minio://server',
    {
      title: 'MinIO Server Info',
      description: 'Configuração e status de conectividade do servidor MinIO',
      mimeType: 'application/json',
    },
    async () => {
      const healthy = await healthCheck();
      const info = {
        endpoint: config.minio.endPoint,
        port: config.minio.port,
        use_ssl: config.minio.useSSL,
        region: config.minio.region,
        public_url: config.minio.publicUrl,
        console_url: config.minio.consoleUrl,
        default_bucket: config.minio.defaultBucket,
        status: healthy ? 'connected' : 'error',
        checked_at: new Date().toISOString(),
      };
      return {
        contents: [
          {
            uri: 'minio://server',
            mimeType: 'application/json',
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    }
  );

  // ─── Resource: minio://buckets ────────────────────────────────────────────
  server.registerResource(
    'minio-buckets',
    'minio://buckets',
    {
      title: 'MinIO Buckets Overview',
      description: 'Lista completa de todos os buckets com contagem de objetos e tamanho total',
      mimeType: 'application/json',
    },
    async () => {
      const buckets = await minio.listBuckets();
      const details = await Promise.allSettled(
        buckets.map(async (b) => {
          try {
            const objects = await listObjectsAsync(b.name, '', true, 10000);
            const totalSize = objects.reduce((acc, o) => acc + (o.size || 0), 0);
            return {
              name: b.name,
              created_at: b.creationDate?.toISOString(),
              object_count: objects.length,
              total_size_bytes: totalSize,
              total_size_human: formatBytes(totalSize),
            };
          } catch {
            return {
              name: b.name,
              created_at: b.creationDate?.toISOString(),
              object_count: null,
              total_size_bytes: null,
              total_size_human: 'N/A',
              error: 'Sem permissão de leitura',
            };
          }
        })
      );

      const data = {
        total_buckets: buckets.length,
        fetched_at: new Date().toISOString(),
        buckets: details.map((r) => (r.status === 'fulfilled' ? r.value : { error: 'Erro ao buscar dados' })),
      };

      return {
        contents: [
          {
            uri: 'minio://buckets',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
