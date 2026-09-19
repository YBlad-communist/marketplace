process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://marketplace:marketplace@localhost:5432/marketplace_test?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-0123456789abcdef0123456789abcdef';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-0123456789abcdef0123456789abcdef';
process.env.APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
process.env.API_URL = process.env.API_URL ?? 'http://localhost:4000';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'marketplace';
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'minioadmin';
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_mock';
process.env.SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
process.env.SMTP_PORT = String(Number(process.env.SMTP_PORT ?? 1025));

// Интеграционные тесты (chat/orders/listings) ожидают в БД категории
// 'services' и 'electronics'. Обеспечиваем их идемпотентно; если БД
// недоступна — тесты скипаются сами, здесь просто молчим.
try {
  const { prisma } = await import('@marketplace/db');
  for (const slug of ['services', 'electronics']) {
    await prisma.category.upsert({
      where: { slug },
      update: {},
      create: { name: slug === 'services' ? 'Услуги' : 'Электроника', slug },
    });
  }
  await prisma.$disconnect();
} catch {
  /* инфра недоступна — integration-наборы скипнутся */
}
