import { Redis } from 'ioredis';
import { env } from '../config.js';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableReadyCheck: true,
    });
  }
  return client;
}

export async function connectRedis(): Promise<Redis> {
  const r = getRedis();
  if (r.status === 'wait') {
    await r.connect();
  }
  return r;
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = null;
  }
}
