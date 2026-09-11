import { Queue } from 'bullmq';
import { QUEUES } from '@marketplace/shared';
import { env } from '../config.js';

type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const queues = new Map<QueueName, Queue>();

export function getQueue<T = unknown>(name: QueueName): Queue<T> {
  let q = queues.get(name) as Queue<T> | undefined;
  if (!q) {
    q = new Queue(name, {
      connection: { url: env.REDIS_URL },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 86400, count: 5000 },
        removeOnFail: { age: 7 * 86400 },
      },
    }) as Queue<T>;
    queues.set(name, q as unknown as Queue);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
