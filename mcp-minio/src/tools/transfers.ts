import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Readable } from 'stream';
import { minio, getObjectBuffer } from '../minio.js';
import { config } from '../config.js';

const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5 MB limit for text content

export function registerTransferTools(server: McpServer): void {
  // ─── 21. get_object_text ─────────────────────────────────────────────────
  server.registerTool(
    'minio_get_object_text',
    {
      description:
        'Faz download do conteúdo de um objeto como texto (UTF-8). ' +
        'Adequado para arquivos .txt, .csv, .html, .md, .xml, .yml, .log, etc. Limite: 5 MB.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto'),
        encoding: z.enum(['utf-8', 'latin1', 'ascii']).default('utf-8').describe('Encoding do texto'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, object, encoding }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const stat = await minio.statObject(targetBucket, object);

      if (stat.size > MAX_TEXT_SIZE) {
        throw new Error(
          `Objeto muito grande para leitura de texto: ${stat.size} bytes. Limite: ${MAX_TEXT_SIZE} bytes (5 MB). ` +
            `Use minio_get_presigned_url para obter uma URL de download.`
        );
      }

      const buffer = await getObjectBuffer(targetBucket, object);
      const content = buffer.toString(encoding as BufferEncoding);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                bucket: targetBucket,
                object,
                size: stat.size,
                content_type: stat.metaData?.['content-type'] || 'unknown',
                content,
              },
              null,
              2
            ),
          },
        ],
        structuredContent: { bucket: targetBucket, object, size: stat.size, content },
      };
    }
  );

  // ─── 22. get_object_json ─────────────────────────────────────────────────
  server.registerTool(
    'minio_get_object_json',
    {
      description:
        'Faz download e faz parse do conteúdo JSON de um objeto. ' +
        'Retorna o objeto JSON parseado diretamente. Limite: 5 MB.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do arquivo .json'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket, object }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const stat = await minio.statObject(targetBucket, object);

      if (stat.size > MAX_TEXT_SIZE) {
        throw new Error(
          `Arquivo JSON muito grande: ${stat.size} bytes. Limite: ${MAX_TEXT_SIZE} bytes (5 MB).`
        );
      }

      const buffer = await getObjectBuffer(targetBucket, object);
      const parsed = JSON.parse(buffer.toString('utf-8'));

      return {
        content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        structuredContent: parsed,
      };
    }
  );

  // ─── 23. put_object_text ─────────────────────────────────────────────────
  server.registerTool(
    'minio_put_object_text',
    {
      description: 'Faz upload de um conteúdo de texto como objeto no MinIO. Ideal para .txt, .csv, .md, .xml, .html.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do objeto a criar. Ex: "reports/2024/relatorio.txt"'),
        content: z.string().describe('Conteúdo de texto a fazer upload'),
        content_type: z
          .string()
          .default('text/plain; charset=utf-8')
          .describe('MIME type. Ex: "text/csv", "text/html", "application/xml"'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Metadados customizados. Ex: {"x-author":"sistema","x-version":"1.0"}'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ bucket, object, content, content_type, metadata }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const buffer = Buffer.from(content, 'utf-8');
      const stream = Readable.from(buffer);

      await minio.putObject(targetBucket, object, stream, buffer.length, {
        'Content-Type': content_type,
        ...metadata,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              bucket: targetBucket,
              object,
              size: buffer.length,
              content_type,
            }),
          },
        ],
        structuredContent: { success: true, bucket: targetBucket, object, size: buffer.length },
      };
    }
  );

  // ─── 24. put_object_json ─────────────────────────────────────────────────
  server.registerTool(
    'minio_put_object_json',
    {
      description: 'Faz upload de um objeto JavaScript/JSON como arquivo .json no MinIO com formatação adequada.',
      inputSchema: {
        bucket: z.string().min(1).optional().describe('Nome do bucket (padrão: bucket configurado)'),
        object: z.string().min(1).describe('Caminho/nome do arquivo. Ex: "data/config.json"'),
        data: z.record(z.unknown()).describe('Objeto JSON a serializar e fazer upload'),
        pretty: z.boolean().default(true).describe('true = JSON formatado com indentação | false = minificado'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Metadados customizados adicionais'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ bucket, object, data, pretty, metadata }) => {
      const targetBucket = bucket || config.minio.defaultBucket;
      const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
      const buffer = Buffer.from(json, 'utf-8');
      const stream = Readable.from(buffer);

      await minio.putObject(targetBucket, object, stream, buffer.length, {
        'Content-Type': 'application/json; charset=utf-8',
        ...metadata,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              bucket: targetBucket,
              object,
              size: buffer.length,
              keys: Object.keys(data).length,
            }),
          },
        ],
        structuredContent: { success: true, bucket: targetBucket, object, size: buffer.length },
      };
    }
  );
}
