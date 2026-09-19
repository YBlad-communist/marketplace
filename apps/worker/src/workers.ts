import { Worker } from 'bullmq';
import {
  EMAIL_JOBS,
  IMAGE_JOBS,
  MAINTENANCE_JOBS,
  MODERATION_JOBS,
  NOTIFICATION_JOBS,
  QUEUES,
  S3_JOBS,
  SMS_JOBS,
} from '@marketplace/shared';
import { env } from './config.js';
import { logger } from './mailer.js';
import { sendEmail } from './mailer.js';
import { sendSms } from './smsru.js';
import { cleanupExpiredTokens } from './cleanup.js';
import { checkExpiredHoldsJob } from './expiredHolds.js';
import { recoverStuckReleasingOrders } from './releasingRecovery.js';
import { sendOfflineDigest } from './offlineDigest.js';
import { processImageJob } from './imageJob.js';
import { moderateListingJob } from './moderationJob.js';
import { savedSearchNotificationJob } from './notificationJob.js';
import { deleteObjectsJob } from './s3Delete.js';

function connection() {
  return { url: env.REDIS_URL };
}

export function createWorkers(): Worker[] {
  const workers: Worker[] = [];

  const emailJobNames = new Set<string>(Object.values(EMAIL_JOBS));

  workers.push(
    new Worker(
      QUEUES.EMAIL,
      async (job) => {
        if (emailJobNames.has(job.name)) {
          const payload = job.data as {
            to: string;
            subject: string;
            text: string;
            html?: string;
            template?: string;
            templateData?: Record<string, unknown>;
          };
          if (!payload?.to || !payload?.subject) {
            throw new Error(`invalid email payload for job ${job.name}`);
          }
          await sendEmail(payload);
          logger.info({ jobId: job.id, jobName: job.name, to: payload.to }, 'email sent');
        } else {
          throw new Error(`unknown email job: ${job.name}`);
        }
      },
      { connection: connection(), concurrency: 5 }
    )
  );

  workers.push(
    new Worker(
      QUEUES.SMS,
      async (job) => {
        if (job.name === SMS_JOBS.SEND) {
          const { phone, text } = job.data as { phone: string; text: string };
          if (!phone || !text) throw new Error(`invalid sms payload for job ${job.name}`);
          await sendSms(phone, text);
        } else {
          throw new Error(`unknown sms job: ${job.name}`);
        }
      },
      { connection: connection(), concurrency: 5 }
    )
  );

  workers.push(
    new Worker(
      QUEUES.IMAGES,
      async (job) => {
        if (job.name === IMAGE_JOBS.PROCESS) {
          await processImageJob(job.data);
        } else {
          throw new Error(`unknown image job: ${job.name}`);
        }
      },
      { connection: connection(), concurrency: 3 }
    )
  );

  workers.push(
    new Worker(
      QUEUES.MODERATION,
      async (job) => {
        if (job.name === MODERATION_JOBS.CHECK_LISTING) {
          await moderateListingJob(job.data);
        } else {
          throw new Error(`unknown moderation job: ${job.name}`);
        }
      },
      { connection: connection(), concurrency: 2 }
    )
  );

  workers.push(
    new Worker(
      QUEUES.NOTIFICATIONS,
      async (job) => {
        if (job.name === NOTIFICATION_JOBS.SAVED_SEARCH_MATCH) {
          await savedSearchNotificationJob(job.data);
        } else {
          throw new Error(`unknown notification job: ${job.name}`);
        }
      },
      { connection: connection(), concurrency: 5 }
    )
  );

  workers.push(
    new Worker(
      QUEUES.MAINTENANCE,
      async (job) => {
        if (
          job.name === MAINTENANCE_JOBS.CLEANUP_TOKENS ||
          job.name === MAINTENANCE_JOBS.CLEANUP_EXPIRED
        ) {
          await cleanupExpiredTokens();
          logger.info({ jobName: job.name }, 'expired tokens cleaned');
        } else if (job.name === MAINTENANCE_JOBS.CHECK_EXPIRED_HOLDS) {
          const result = await checkExpiredHoldsJob();
          logger.info({ jobName: job.name, ...result }, 'expired holds checked');
        } else if (job.name === MAINTENANCE_JOBS.RECOVER_RELEASING) {
          const result = await recoverStuckReleasingOrders();
          logger.info({ jobName: job.name, ...result }, 'stuck releasing orders recovered');
        } else if (job.name === MAINTENANCE_JOBS.SEND_OFFLINE_DIGEST) {
          const result = await sendOfflineDigest(job.data as { receiverId?: unknown; conversationId?: unknown });
          logger.info({ jobName: job.name, ...result }, 'offline digest sent');
        } else {
          throw new Error(`unknown maintenance job: ${job.name}`);
        }
      },
      { connection: connection(), concurrency: 1 }
    )
  );

  workers.push(
    new Worker(
      QUEUES.S3,
      async (job) => {
        if (job.name === S3_JOBS.DELETE_OBJECT) {
          const result = await deleteObjectsJob(job.data as { keys?: unknown });
          logger.info({ jobId: job.id, ...result }, 's3 objects deleted');
        } else {
          throw new Error(`unknown s3 job: ${job.name}`);
        }
      },
      { connection: connection(), concurrency: 3 }
    )
  );

  for (const w of workers) {
    w.on('failed', (job, err) => {
      logger.error({ err, jobId: job?.id, queue: job?.queueName }, 'job failed');
    });
    w.on('error', (err) => {
      logger.error({ err }, 'worker error');
    });
  }

  return workers;
}
