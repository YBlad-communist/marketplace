import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from './config.js';
import { logger } from './mailer.js';

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return client;
}

/**
 * Префиксы, которыми владеет приложение (п.19 аудита): удалять можно только
 * их. chat/ — приватный префикс фото чатов (п.20), images/ — обработанные
 * файлы, raw/ — загрузки до подтверждения. Всё остальное (чужие ключи,
 * '..', абсолютные URL) пропускаем с warn — иначе подделанный payload
 * джобы удалял бы произвольные объекты бакета.
 */
const SAFE_DELETE_PREFIXES = ['images/', 'raw/', 'chat/'];

export function isSafeDeleteKey(key: string): boolean {
  return !key.includes('..') && SAFE_DELETE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Удаление объектов из бакета. Вызывается BullMQ-джобой (ретраи из коробки),
 * поэтому временная недоступность S3/MinIO не теряет объекты сиротами.
 * Несуществующий объект — не ошибка: DeleteObject идемпотентен.
 */
export async function deleteObjectsJob(payload: { keys?: unknown }): Promise<{ attempted: number }> {
  const keys = Array.isArray(payload?.keys) ? payload.keys.filter((k): k is string => typeof k === 'string') : [];
  if (keys.length === 0) {
    throw new Error('invalid s3 delete payload: keys required');
  }
  let attempted = 0;
  for (const key of keys) {
    if (!isSafeDeleteKey(key)) {
      logger.warn({ key }, 's3 delete skipped: unsafe key (audit p.19)');
      continue;
    }
    try {
      await getClient().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      attempted += 1;
    } catch (err) {
      logger.warn({ err, key }, 's3 delete failed, will retry via bullmq');
      throw err;
    }
  }
  return { attempted };
}