import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { minio, listObjectsAsync, formatBytes, healthCheck } from '../minio.js';
import { config } from '../config.js';

export function registerAdminTools(server: McpServer): void {
  // ─── 25. server_info ─────────────────────────────────────────────────────
  server.registerTool(
    'minio_server_info',
    {
      description: 'Retorna informações de configuração do servidor MinIO e status de conectividade.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
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
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
        structuredContent: info,
      };
    }
  );

  // ─── 26. bucket_summary ──────────────────────────────────────────────────
  server.registerTool(
    'minio_bucket_summary',
    {
      description:
        'Calcula estatísticas de um bucket: total de objetos, tamanho acumulado e breakdown por extensão de arquivo. ' +
        'Atenção: pode ser lento para buckets muito grandes.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        prefix: z.string().default('').describe('Prefixo/pasta para limitar a análise'),
        max_objects: z
          .number()
          .int()
          .min(1)
          .max(50000)
          .default(5000)
          .describe('Máximo de objetos a analisar'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, prefix, max_objects }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const objects = await listObjectsAsync(targetBucket, prefix, true, max_objects);

      let totalSize = 0;
      const byExtension: Record<string, { count: number; size: number }> = {};

      for (const obj of objects) {
        if (!obj.name) continue;
        const size = obj.size || 0;
        totalSize += size;

        const ext = obj.name.includes('.')
          ? obj.name.split('.').pop()!.toLowerCase()
          : '(sem extensão)';

        if (!byExtension[ext]) byExtension[ext] = { count: 0, size: 0 };
        byExtension[ext].count++;
        byExtension[ext].size += size;
      }

      const extensionSummary = Object.entries(byExtension)
        .sort((a, b) => b[1].size - a[1].size)
        .map(([ext, stats]) => ({
          extension: ext,
          count: stats.count,
          size_bytes: stats.size,
          size_human: formatBytes(stats.size),
        }));

      const summary = {
        bucket: targetBucket,
        prefix: prefix || '(raiz)',
        total_objects: objects.length,
        total_size_bytes: totalSize,
        total_size_human: formatBytes(totalSize),
        truncated: objects.length >= max_objects,
        by_extension: extensionSummary,
        analyzed_at: new Date().toISOString(),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary,
      };
    }
  );

  // ─── 27. search_objects ──────────────────────────────────────────────────
  server.registerTool(
    'minio_search_objects',
    {
      description:
        'Busca objetos em um bucket por padrão de nome (substring, sufixo ou extensão). ' +
        'Exemplos: buscar ".pdf", "relatorio_", "2024".',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        prefix: z.string().default('').describe('Prefixo base para limitar a busca. Ex: "uploads/"'),
        pattern: z.string().min(1).describe('Padrão de busca (substring no nome do objeto). Ex: ".pdf", "invoice_"'),
        case_sensitive: z.boolean().default(false).describe('Diferencia maiúsculas/minúsculas'),
        max_results: z.number().int().min(1).max(1000).default(100).describe('Máximo de resultados'),
        max_scan: z
          .number()
          .int()
          .min(100)
          .max(50000)
          .default(5000)
          .describe('Máximo de objetos a escanear na busca'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, prefix, pattern, case_sensitive, max_results, max_scan }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const objects = await listObjectsAsync(targetBucket, prefix, true, max_scan);

      const searchPattern = case_sensitive ? pattern : pattern.toLowerCase();
      const matches = [];

      for (const obj of objects) {
        if (!obj.name) continue;
        const name = case_sensitive ? obj.name : obj.name.toLowerCase();
        if (name.includes(searchPattern)) {
          matches.push({
            name: obj.name,
            size: obj.size,
            size_human: formatBytes(obj.size || 0),
            last_modified: obj.lastModified?.toISOString(),
          });
          if (matches.length >= max_results) break;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                bucket: targetBucket,
                pattern,
                scanned: objects.length,
                found: matches.length,
                truncated: matches.length >= max_results,
                results: matches,
              },
              null,
              2
            ),
          },
        ],
        structuredContent: { bucket: targetBucket, pattern, found: matches.length, results: matches },
      };
    }
  );

  // ─── 28. generate_public_url ─────────────────────────────────────────────
  server.registerTool(
    'minio_generate_public_url',
    {
      description:
        'Gera a URL pública permanente de um objeto (sem expiração), usando a MINIO_PUBLIC_URL configurada. ' +
        'O objeto deve estar em um bucket com política pública de leitura.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, object }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const baseUrl = config.minio.publicUrl.replace(/\/$/, '');
      const url = `${baseUrl}/${targetBucket}/${object}`;

      return {
        content: [{ type: 'text', text: JSON.stringify({ bucket: targetBucket, object, public_url: url }) }],
        structuredContent: { bucket: targetBucket, object, public_url: url },
      };
    }
  );

  // ─── 29. list_incomplete_uploads ─────────────────────────────────────────
  server.registerTool(
    'minio_list_incomplete_uploads',
    {
      description: 'Lista uploads multipart incompletos (abandonados) em um bucket que ocupam espaço desnecessário.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        prefix: z.string().default('').describe('Prefixo para filtrar'),
        max_results: z.number().int().min(1).max(1000).default(100).describe('Máximo de resultados'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, prefix, max_results }) => {
      const targetBucket = bucket || config.minio.defaultBucket;

      return new Promise((resolve, reject) => {
        const uploads: Array<{
          key: string;
          upload_id: string;
          size: number;
          size_human: string;
          initiated: string | undefined;
        }> = [];
        const stream = minio.listIncompleteUploads(targetBucket, prefix, true);

        stream.on('data', (item) => {
          if (uploads.length < max_results) {
            uploads.push({
              key: item.key,
              upload_id: item.uploadId,
              size: item.size || 0,
              size_human: formatBytes(item.size || 0),
              initiated: undefined as string | undefined,
            });
          }
        });

        stream.on('error', reject);
        stream.on('end', () => {
          const totalSize = uploads.reduce((acc, u) => acc + u.size, 0);
          const result = {
            bucket: targetBucket,
            count: uploads.length,
            wasted_size: formatBytes(totalSize),
            wasted_bytes: totalSize,
            uploads,
          };
          resolve({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          });
        });
      });
    }
  );

  // ─── 30. abort_incomplete_upload ─────────────────────────────────────────
  server.registerTool(
    'minio_abort_incomplete_upload',
    {
      description:
        'Aborta e remove um upload multipart incompleto de um objeto. ' +
        'Use minio_list_incomplete_uploads para obter os objetos disponíveis.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Chave (key) do upload incompleto a abortar'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ bucket, object }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      await minio.removeIncompleteUpload(targetBucket, object);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, bucket: targetBucket, object, aborted: true }),
          },
        ],
        structuredContent: { success: true, bucket: targetBucket, object, aborted: true },
      };
    }
  );
}
