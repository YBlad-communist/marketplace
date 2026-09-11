import {
  EMAIL_JOBS,
  IMAGE_JOBS,
  MAINTENANCE_JOBS,
  NOTIFICATION_JOBS,
  QUEUES,
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
