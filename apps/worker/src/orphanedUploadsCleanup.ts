import { deleteObject, listObjectsOlderThan } from './lib/s3.js';
import { logger } from './mailer.js';

export const RAW_PREFIX = 'raw/';
const DEFAULT_GRACE_HOURS = 48; // с запасом сверх 15-минутного окна presigned URL

/**
 * Чистка брошенных сырых загрузок: файлы, залитые в S3 по presigned URL,
 * но так и не подтверждённые (пользователь передумал/закрыл вкладку).
 * Видит только объекты под raw/ — подтверждённые фото живут под другими
 * ключами и джобой не затрагиваются.
 */
export async function cleanupOrphanedUploads(graceHours = DEFAULT_GRACE_HOURS): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - graceHours * 3600_000);
  const staleKeys = await listObjectsOlderThan(RAW_PREFIX, cutoff);
  let deleted = 0;
  for (const key of staleKeys) {
    try {
      await deleteObject(key);
      deleted += 1;
    } catch (err) {
      logger.error({ err, key }, 'failed to delete orphaned raw upload');
    }
  }
  return { deleted };
}
