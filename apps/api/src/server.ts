import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config.js';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from './lib/redis.js';
import { initSocket } from './lib/socket.js';
import { logger } from './lib/logger.js';
import { closeQueues } from './queues/index.js';
import { enqueueTokenCleanup, enqueueExpiredHoldsCheck, enqueueReleasingRecovery, enqueueOrphanedUploadsCleanup } from './services/notificationService.js';
import { scheduleCriticalJob } from './services/jobScheduler.js';

async function main() {
  await connectRedis();
  await prisma.$connect();
  logger.info('database connected');

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  server.listen(env.PORT, () => {
    logger.info(`API listening on :${env.PORT}`);
  });

  // Защитные repeatable-джобы: если Redis при старте на секунду недоступен,
  // ретраим с backoff и фиксируем ошибку в лог, а не глотаем молча — иначе
  // чистка холдов / recovery выплат не запланируется без единой строчки.
  await scheduleCriticalJob('enqueueTokenCleanup', () => enqueueTokenCleanup());
  await scheduleCriticalJob('enqueueExpiredHoldsCheck', () => enqueueExpiredHoldsCheck());
  await scheduleCriticalJob('enqueueReleasingRecovery', () => enqueueReleasingRecovery());
  await scheduleCriticalJob('enqueueOrphanedUploadsCleanup', () => enqueueOrphanedUploadsCleanup());

  const shutdown = async (signal: string) => {
    logger.info(`received ${signal}, shutting down`);
    server.close(async () => {
      await closeQueues().catch(() => undefined);
      await disconnectRedis().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
