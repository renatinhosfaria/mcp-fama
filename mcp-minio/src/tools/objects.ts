import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CopyConditions } from 'minio';
import { minio, listObjectsAsync, formatBytes, formatStat } from '../minio.js';
import { config } from '../config.js';

export function registerObjectTools(server: McpServer): void {
  // ─── 11. list_objects ────────────────────────────────────────────────────
  server.registerTool(
    'minio_list_objects',
    {
      description:
        'Lista objetos em um bucket com suporte a prefixo, busca recursiva e paginação. ' +
        'Retorna nome, tamanho, etag e data de modificação.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket (padrão: bucket configurado)').optional(),
        prefix: z.string().default('').describe('Prefixo/pasta para filtrar objetos. Ex: "uploads/2024/"'),
        recursive: z.boolean().default(false).describe('true = lista todos os subdiretórios | false = lista apenas o nível atual'),
        max_keys: z.number().int().min(1).max(10000).default(200).describe('Máximo de objetos retornados (1-10000)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, prefix, recursive, max_keys }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const objects = await listObjectsAsync(targetBucket, prefix, recursive, max_keys);

      const data = objects.map((obj) => ({
        name: obj.name,
        prefix: obj.prefix,
        size: obj.size,
        size_human: obj.size !== undefined ? formatBytes(obj.size) : undefined,
        etag: obj.etag,
        last_modified: obj.lastModified?.toISOString(),
      }));

      const totalSize = data.reduce((acc, o) => acc + (o.size || 0), 0);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { bucket: targetBucket, prefix, recursive, count: data.length, total_size: formatBytes(totalSize), objects: data },
              null,
              2
            ),
          },
        ],
        structuredContent: { bucket: targetBucket, count: data.length, total_size_bytes: totalSize, objects: data },
      };
    }
  );

  // ─── 12. get_object_info ─────────────────────────────────────────────────
  server.registerTool(
    'minio_get_object_info',
    {
      description: 'Retorna metadados de um objeto: tamanho, etag, data de modificação, content-type e metadados customizados.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto. Ex: "uploads/foto.jpg"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, object }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const stat = await minio.statObject(targetBucket, object);
      const data = formatStat(object, stat);

      return {
        content: [{ type: 'text', text: JSON.stringify({ bucket: targetBucket, ...data }, null, 2) }],
        structuredContent: { bucket: targetBucket, ...data },
      };
    }
  );

  // ─── 13. delete_object ───────────────────────────────────────────────────
  server.registerTool(
    'minio_delete_object',
    {
      description: 'Remove um único objeto de um bucket.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto a remover'),
        version_id: z.string().optional().describe('ID da versão específica (para buckets com versionamento)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ bucket, object, version_id }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      await minio.removeObject(targetBucket, object, version_id ? { versionId: version_id } : undefined);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket: targetBucket, object, deleted: true }) }],
        structuredContent: { success: true, bucket: targetBucket, object, deleted: true },
      };
    }
  );

  // ─── 14. delete_objects ──────────────────────────────────────────────────
  server.registerTool(
    'minio_delete_objects',
    {
      description: 'Remove múltiplos objetos de um bucket em uma única operação (até 1000 objetos).',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        objects: z
          .array(z.string().min(1))
          .min(1)
          .max(1000)
          .describe('Lista de nomes/caminhos dos objetos a remover'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ bucket, objects }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      await minio.removeObjects(targetBucket, objects);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, bucket: targetBucket, deleted_count: objects.length, objects }),
          },
        ],
        structuredContent: { success: true, bucket: targetBucket, deleted_count: objects.length },
      };
    }
  );

  // ─── 15. copy_object ─────────────────────────────────────────────────────
  server.registerTool(
    'minio_copy_object',
    {
      description: 'Copia um objeto de uma origem para um destino (dentro do mesmo servidor MinIO).',
      inputSchema: {
        source_bucket: z.string().min(1).describe('Bucket de origem'),
        source_object: z.string().min(1).describe('Caminho do objeto de origem'),
        dest_bucket: z.string().min(1).describe('Bucket de destino'),
        dest_object: z.string().min(1).describe('Caminho do objeto de destino'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ source_bucket, source_object, dest_bucket, dest_object }) => {
      const conditions = new CopyConditions();
      await minio.copyObject(dest_bucket, dest_object, `/${source_bucket}/${source_object}`, conditions);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              source: `${source_bucket}/${source_object}`,
              destination: `${dest_bucket}/${dest_object}`,
            }),
          },
        ],
        structuredContent: { success: true, source_bucket, source_object, dest_bucket, dest_object },
      };
    }
  );

  // ─── 16. move_object ─────────────────────────────────────────────────────
  server.registerTool(
    'minio_move_object',
    {
      description: 'Move um objeto (copia para destino e remove da origem). Operação atômica via copy + delete.',
      inputSchema: {
        source_bucket: z.string().min(1).describe('Bucket de origem'),
        source_object: z.string().min(1).describe('Caminho do objeto de origem'),
        dest_bucket: z.string().min(1).describe('Bucket de destino'),
        dest_object: z.string().min(1).describe('Caminho do objeto de destino'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ source_bucket, source_object, dest_bucket, dest_object }) => {
      const conditions = new CopyConditions();
      await minio.copyObject(dest_bucket, dest_object, `/${source_bucket}/${source_object}`, conditions);
      await minio.removeObject(source_bucket, source_object);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              moved_from: `${source_bucket}/${source_object}`,
              moved_to: `${dest_bucket}/${dest_object}`,
            }),
          },
        ],
        structuredContent: { success: true, source_bucket, source_object, dest_bucket, dest_object },
      };
    }
  );

  // ─── 17. get_object_tags ─────────────────────────────────────────────────
  server.registerTool(
    'minio_get_object_tags',
    {
      description: 'Retorna as tags (metadados chave-valor) de um objeto.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, object }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const tags = await minio.getObjectTagging(targetBucket, object);
      return {
        content: [{ type: 'text', text: JSON.stringify({ bucket: targetBucket, object, tags }) }],
        structuredContent: { bucket: targetBucket, object, tags },
      };
    }
  );

  // ─── 18. set_object_tags ─────────────────────────────────────────────────
  server.registerTool(
    'minio_set_object_tags',
    {
      description: 'Define ou substitui as tags (metadados chave-valor) de um objeto.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto'),
        tags: z.record(z.string()).describe('Objeto JSON com pares chave-valor. Ex: {"project":"crm","type":"avatar"}'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bucket, object, tags }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      await minio.setObjectTagging(targetBucket, object, tags);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket: targetBucket, object, tags }) }],
        structuredContent: { success: true, bucket: targetBucket, object, tags },
      };
    }
  );

  // ─── 19. remove_object_tags ──────────────────────────────────────────────
  server.registerTool(
    'minio_remove_object_tags',
    {
      description: 'Remove todas as tags de um objeto.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto'),
        version_id: z.string().optional().describe('ID da versão (para buckets com versionamento)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bucket, object, version_id }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      await minio.removeObjectTagging(targetBucket, object, { versionId: version_id || '' });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket: targetBucket, object, tags_removed: true }) }],
        structuredContent: { success: true, bucket: targetBucket, object },
      };
    }
  );

  // ─── 20. get_presigned_url ───────────────────────────────────────────────
  server.registerTool(
    'minio_get_presigned_url',
    {
      description:
        'Gera uma URL pré-assinada para acesso temporário a um objeto sem autenticação. ' +
        'GET = download | PUT = upload direto do cliente.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto'),
        method: z.enum(['GET', 'PUT']).default('GET').describe('GET = download | PUT = upload'),
        expiry_seconds: z
          .number()
          .int()
          .min(1)
          .max(604800)
          .default(3600)
          .describe('Validade da URL em segundos (máx: 604800 = 7 dias)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, object, method, expiry_seconds }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      let url: string;

      if (method === 'PUT') {
        url = await minio.presignedPutObject(targetBucket, object, expiry_seconds);
      } else {
        url = await minio.presignedGetObject(targetBucket, object, expiry_seconds);
      }

      const expiresAt = new Date(Date.now() + expiry_seconds * 1000).toISOString();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ bucket: targetBucket, object, method, url, expires_at: expiresAt, expiry_seconds }),
          },
        ],
        structuredContent: { bucket: targetBucket, object, method, url, expires_at: expiresAt },
      };
    }
  );
}
