process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://marketplace:marketplace@localhost:5432/marketplace_test?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID ?? 'shop_mock';
process.env.YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY ?? 'secret_mock';
process.env.SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
process.env.SMTP_PORT = String(process.env.SMTP_PORT ?? 1025);