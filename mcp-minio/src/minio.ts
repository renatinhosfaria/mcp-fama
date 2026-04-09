import { Client as MinioClient, BucketItem, BucketItemStat } from 'minio';
import { config } from './config.js';

export const minio = new MinioClient({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
  region: config.minio.region,
  pathStyle: true,
});

// Helper: list objects as a promise (EventEmitter → Promise)
export function listObjectsAsync(
  bucket: string,
  prefix = '',
  recursive = false,
  maxKeys = 1000
): Promise<BucketItem[]> {
  return new Promise((resolve, reject) => {
    const objects: BucketItem[] = [];
    const stream = minio.listObjectsV2(bucket, prefix, recursive);

    stream.on('data', (obj) => {
      if (objects.length < maxKeys) objects.push(obj);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(objects));
  });
}

// Helper: get object content as Buffer
export async function getObjectBuffer(bucket: string, objectName: string): Promise<Buffer> {
  const stream = await minio.getObject(bucket, objectName);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// Helper: format bytes
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

// Helper: format BucketItemStat
export function formatStat(objectName: string, stat: BucketItemStat) {
  return {
    name: objectName,
    size: stat.size,
    size_human: formatBytes(stat.size),
    etag: stat.etag,
    last_modified: stat.lastModified?.toISOString(),
    content_type: stat.metaData?.['content-type'] || stat.metaData?.['Content-Type'] || 'unknown',
    metadata: stat.metaData,
  };
}

// Health check — verifica conectividade com MinIO
export async function healthCheck(): Promise<boolean> {
  try {
    await minio.listBuckets();
    return true;
  } catch {
    return false;
  }
}
