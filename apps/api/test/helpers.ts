import { prisma } from '@marketplace/db';
import { Redis } from 'ioredis';

/**
 * Пользователь, зарегистрированный через API, не имеет phoneVerifiedAt —
 * аудит п.8 запрещает создание заказов без подтверждённого телефона.
 * Вызывайте после register, чтобы интеграционные тесты заказов проходили.
 */
export async function markPhoneVerified(phone: string): Promise<void> {
  await prisma.user.updateMany({
    where: { phone },
    data: { phoneVerifiedAt: new Date(), isVerified: true },
  });
}

/** Проверка доступности инфраструктуры для интеграционных тестов. */
export async function isInfraAvailable(): Promise<boolean> {
  try {
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null as never,
    });
    redis.on('error', () => undefined);
    await redis.connect();
    await redis.ping();
    redis.disconnect();
  } catch {
    return false;
  }

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2500)),
    ]);
  } catch {
    return false;
  }
  return true;
}
