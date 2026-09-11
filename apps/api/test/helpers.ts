import { prisma } from '@marketplace/db';
import { Redis } from 'ioredis';

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

export async function runIfInfra(suiteFn: () => void): Promise<boolean> {
  const ok = await isInfraAvailable();
  if (!ok) {
    return false;
  }
  suiteFn();
  return true;
}
