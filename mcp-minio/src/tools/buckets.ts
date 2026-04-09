import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { minio } from '../minio.js';

export function registerBucketTools(server: McpServer): void {
  // ─── 1. list_buckets ─────────────────────────────────────────────────────
  server.registerTool(
    'minio_list_buckets',
    {
      description: 'Lista todos os buckets disponíveis no servidor MinIO com data de criação.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const buckets = await minio.listBuckets();
      const data = buckets.map((b) => ({
        name: b.name,
        created_at: b.creationDate?.toISOString(),
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: { buckets: data, total: data.length },
      };
    }
  );

  // ─── 2. bucket_exists ────────────────────────────────────────────────────
  server.registerTool(
    'minio_bucket_exists',
    {
      description: 'Verifica se um bucket existe no MinIO.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket }) => {
      const exists = await minio.bucketExists(bucket);
      return {
        content: [{ type: 'text', text: JSON.stringify({ bucket, exists }) }],
        structuredContent: { bucket, exists },
      };
    }
  );

  // ─── 3. create_bucket ────────────────────────────────────────────────────
  server.registerTool(
    'minio_create_bucket',
    {
      description: 'Cria um novo bucket no MinIO.',
      inputSchema: {
        bucket: z.string().min(3).max(63).describe('Nome do bucket (3-63 caracteres, lowercase)'),
        region: z.string().optional().describe('Região (padrão: us-east-1)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ bucket, region }) => {
      await minio.makeBucket(bucket, region || 'us-east-1');
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket, region: region || 'us-east-1' }) }],
        structuredContent: { success: true, bucket },
      };
    }
  );

  // ─── 4. delete_bucket ────────────────────────────────────────────────────
  server.registerTool(
    'minio_delete_bucket',
    {
      description: 'Remove um bucket vazio do MinIO. O bucket deve estar vazio antes da exclusão.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket a remover'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ bucket }) => {
      await minio.removeBucket(bucket);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket, deleted: true }) }],
        structuredContent: { success: true, bucket, deleted: true },
      };
    }
  );

  // ─── 5. get_bucket_policy ────────────────────────────────────────────────
  server.registerTool(
    'minio_get_bucket_policy',
    {
      description: 'Retorna a política de acesso IAM (JSON) de um bucket.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket }) => {
      try {
        const policy = await minio.getBucketPolicy(bucket);
        const parsed = JSON.parse(policy);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
          structuredContent: parsed,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NoSuchBucketPolicy')) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ bucket, policy: null, message: 'Nenhuma política definida' }) }],
            structuredContent: { bucket, policy: null },
          };
        }
        throw err;
      }
    }
  );

  // ─── 6. set_bucket_policy ────────────────────────────────────────────────
  server.registerTool(
    'minio_set_bucket_policy',
    {
      description: 'Define a política de acesso IAM de um bucket. Use policy_json como string JSON válida.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket'),
        policy_json: z.string().describe('Política IAM em formato JSON string'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bucket, policy_json }) => {
      JSON.parse(policy_json); // valida JSON antes de enviar
      await minio.setBucketPolicy(bucket, policy_json);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket }) }],
        structuredContent: { success: true, bucket },
      };
    }
  );

  // ─── 7. get_bucket_versioning ────────────────────────────────────────────
  server.registerTool(
    'minio_get_bucket_versioning',
    {
      description: 'Retorna a configuração de versionamento de um bucket.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket }) => {
      const config = await minio.getBucketVersioning(bucket);
      return {
        content: [{ type: 'text', text: JSON.stringify({ bucket, versioning: config }) }],
        structuredContent: { bucket, versioning: config },
      };
    }
  );

  // ─── 8. set_bucket_versioning ────────────────────────────────────────────
  server.registerTool(
    'minio_set_bucket_versioning',
    {
      description: 'Ativa ou suspende o versionamento de objetos em um bucket.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket'),
        status: z.enum(['Enabled', 'Suspended']).describe('Enabled = ativar | Suspended = suspender'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bucket, status }) => {
      await minio.setBucketVersioning(bucket, { Status: status });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket, status }) }],
        structuredContent: { success: true, bucket, status },
      };
    }
  );

  // ─── 9. get_bucket_tags ──────────────────────────────────────────────────
  server.registerTool(
    'minio_get_bucket_tags',
    {
      description: 'Retorna as tags (metadados chave-valor) de um bucket.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket }) => {
      const tags = await minio.getBucketTagging(bucket);
      return {
        content: [{ type: 'text', text: JSON.stringify({ bucket, tags }) }],
        structuredContent: { bucket, tags },
      };
    }
  );

  // ─── 10. set_bucket_tags ─────────────────────────────────────────────────
  server.registerTool(
    'minio_set_bucket_tags',
    {
      description: 'Define tags (metadados chave-valor) em um bucket. Substitui todas as tags existentes.',
      inputSchema: {
        bucket: z.string().min(1).describe('Nome do bucket'),
        tags: z.record(z.string()).describe('Objeto JSON com pares chave-valor. Ex: {"env":"prod","team":"devops"}'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bucket, tags }) => {
      await minio.setBucketTagging(bucket, tags);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, bucket, tags }) }],
        structuredContent: { success: true, bucket, tags },
      };
    }
  );
}
