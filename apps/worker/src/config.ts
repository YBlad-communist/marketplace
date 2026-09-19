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
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE !== 'false',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  YOOKASSA_SHOP_ID: process.env.YOOKASSA_SHOP_ID ?? '',
  YOOKASSA_SECRET_KEY: process.env.YOOKASSA_SECRET_KEY ?? '',
  // Комиссия платформы: обязана совпадать с API (apps/api/src/config.ts),
  // чтобы recovery-джоба считала ту же сумму комиссии, что и releaseOrder.
  YOOKASSA_PLATFORM_FEE_BASIS_POINTS: Number(process.env.YOOKASSA_PLATFORM_FEE_BASIS_POINTS ?? 200),
  // Возраст RELEASING-заказа, после которого запускается восстановление
  // (если releaseOrder упал между capture и финальной транзакцией).
  RELEASING_RECOVERY_AFTER_MS: Number(process.env.RELEASING_RECOVERY_AFTER_MS ?? 5 * 60_000),
  // Возраст PAID-заказа в днях, после которого холд считаем истёкшим
  // (ЮKassa сама отменяет авторизации, не завершённые capture, примерно через
  // 7 дней; точный срок зависит от договора и способа оплаты).
  YOOKASSA_HOLD_TTL_DAYS: Number(process.env.YOOKASSA_HOLD_TTL_DAYS ?? 7),
};

export const isProd = env.NODE_ENV === 'production';
