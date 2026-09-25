import {
  EMAIL_JOBS,
  IMAGE_JOBS,
  MAINTENANCE_JOBS,
  NOTIFICATION_JOBS,
  QUEUES,
  S3_JOBS,
  SMS_JOBS,
} from '@marketplace/shared';
import { getQueue } from '../queues/index.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  template?: 'verification' | 'password-reset' | 'new-message' | 'order-updated';
  templateData?: Record<string, unknown>;
}

export async function enqueueEmail(email: EmailMessage): Promise<void> {
  await getQueue(QUEUES.EMAIL).add(EMAIL_JOBS.SEND, email, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export async function enqueueSms(phone: string, text: string): Promise<void> {
  await getQueue(QUEUES.SMS).add(SMS_JOBS.SEND, { phone, text }, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export async function enqueueImageProcess(key: string): Promise<void> {
  await getQueue(QUEUES.IMAGES).add(IMAGE_JOBS.PROCESS, { key });
}

export async function enqueueSavedSearchCheck(userId: string, listingId: string): Promise<void> {
  await getQueue(QUEUES.NOTIFICATIONS).add(NOTIFICATION_JOBS.SAVED_SEARCH_MATCH, {
    userId,
    listingId,
  });
}

export async function enqueueTokenCleanup(): Promise<void> {
  await getQueue(QUEUES.MAINTENANCE).add(MAINTENANCE_JOBS.CLEANUP_TOKENS, {}, {
    repeat: { every: 3600_000 },
    jobId: 'cleanup-tokens-repeat',
  });
}

export async function enqueueExpiredHoldsCheck(): Promise<void> {
  await getQueue(QUEUES.MAINTENANCE).add(MAINTENANCE_JOBS.CHECK_EXPIRED_HOLDS, {}, {
    repeat: { every: 6 * 3600_000 },
    jobId: 'expired-holds-repeat',
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
  });
}

export async function enqueueReleasingRecovery(): Promise<void> {
  await getQueue(QUEUES.MAINTENANCE).add(MAINTENANCE_JOBS.RECOVER_RELEASING, {}, {
    repeat: { every: 15 * 60_000 },
    jobId: 'releasing-recovery-repeat',
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
  });
}

export async function enqueueOrphanedUploadsCleanup(): Promise<void> {
  await getQueue(QUEUES.MAINTENANCE).add(MAINTENANCE_JOBS.CLEANUP_ORPHANED_UPLOADS, {}, {
    repeat: { every: 6 * 3600_000 },
    jobId: 'orphaned-uploads-cleanup-repeat',
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
  });
}

/**
 * Удаление объектов из S3 в фоне: ретраи BullMQ есть из коробки, поэтому
 * удаление переживает временные падения S3/MinIO, а ответ API не зависит от
 * работы хранилища (иначе после prisma.delete объекты оставались бы сиротами).
 */
export async function enqueueS3Delete(keys: string[]): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  await getQueue(QUEUES.S3).add(
    S3_JOBS.DELETE_OBJECT,
    { keys: unique },
    { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } }
  );
}
