import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback ?? '';
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

export const env = {
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  DATABASE_URL: required('DATABASE_URL'),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  APP_URL: process.env.APP_URL ?? 'http://localhost:3000',
  SMTP_HOST: process.env.SMTP_HOST ?? '',
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 1025),
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_REGION: process.env.S3_REGION ?? 'auto',
  S3_BUCKET: process.env.S3_BUCKET ?? 'marketplace',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL ?? 'http://localhost:9000/marketplace',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
};

export const isProd = env.NODE_ENV === 'production';
