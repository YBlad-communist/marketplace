import 'dotenv/config';
import { prisma } from '@marketplace/db';
import { logger } from './mailer.js';
import { createWorkers } from './workers.js';

async function main() {
  await prisma.$connect();
  logger.info('worker connected to db');

  const workers = createWorkers();
  logger.info(`started ${workers.length} bullmq workers`);

  const shutdown = async (signal: string) => {
    logger.info(`received ${signal}, closing workers`);
    await Promise.all(workers.map((w) => w.close())).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal worker error');
  process.exit(1);
});
