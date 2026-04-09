import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3200', 10),
  apiKey: process.env.API_KEY!,
  rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '300', 10),

  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY!,
    secretKey: process.env.MINIO_SECRET_KEY!,
    region: process.env.MINIO_REGION || 'us-east-1',
    defaultBucket: process.env.MINIO_BUCKET_NAME || '',
    publicUrl: process.env.MINIO_PUBLIC_URL || '',
    consoleUrl: process.env.MINIO_CONSOLE_URL || '',
  },
};

if (!config.apiKey) throw new Error('API_KEY is required');
if (!config.minio.accessKey) throw new Error('MINIO_ACCESS_KEY is required');
if (!config.minio.secretKey) throw new Error('MINIO_SECRET_KEY is required');
