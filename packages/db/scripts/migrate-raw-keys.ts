/**
 * Одноразовая миграция ключей S3: переносит готовые файлы из raw/ в images/.
 *
 * Контекст: до фикса processImage писал итоговые webp рядом с исходником
 * (raw/<id>.webp), из-за чего чистка cleanupOrphanedUploads удаляла готовые
 * фото. Скрипт для каждой записи (ListingImage.key, Message.imageKey /
 * imageThumbKey, User.avatarUrl), чей ключ начинается с raw/, копирует объект
 * в новый ключ images/<id>.webp (или <id>_thumb.webp), обновляет БД, затем
 * удаляет старый объект. Запуск идемпотентен: повторный прогон не находит
 * raw/-записей.
 *
 * Использование:
 *   pnpm --filter @marketplace/db db:migrate-raw-keys
 *   (или npx tsx packages/db/scripts/migrate-raw-keys.ts)
 *
 * Env: DATABASE_URL, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE, S3_PUBLIC_BASE_URL.
 */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'auto',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  },
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
});

const bucket = process.env.S3_BUCKET ?? 'marketplace';
const publicBase = process.env.S3_PUBLIC_BASE_URL ?? 'http://localhost:9000/marketplace';

/** Тот же вывод, что deriveOutputKeys в apps/api/src/services/imageService.ts. */
function toImageKey(rawKey: string): string {
  const id = rawKey.replace(/\.[a-z0-9]+$/i, '').replace(/^.*\//, '');
  const isThumb = /_thumb$/i.test(id);
  const base = isThumb ? id.replace(/_thumb$/i, '') : id;
  return isThumb ? `images/${base}_thumb.webp` : `images/${base}.webp`;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function copyObject(fromKey: string, toKey: string): Promise<void> {
  // CopyObject внутри того же бакета — не тянет объект через память клиента.
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
      Key: toKey,
    })
  );
}

interface MigrationResult {
  scanned: number;
  copied: number;
  skippedMissing: number;
  dbUpdated: number;
  errors: number;
}

async function migrateKey(
  oldKey: string | null | undefined,
  apply: (newKey: string) => Promise<unknown>,
  result: MigrationResult
): Promise<void> {
  if (!oldKey || !oldKey.startsWith('raw/')) return;
  result.scanned += 1;
  const newKey = toImageKey(oldKey);
  try {
    if (!(await objectExists(oldKey))) {
      result.skippedMissing += 1;
      console.warn(`[migrate-raw-keys] объект не найден, пропускаю: ${oldKey}`);
      return;
    }
    if (await objectExists(newKey)) {
      console.warn(`[migrate-raw-keys] цель уже существует, только БД: ${oldKey} -> ${newKey}`);
    } else {
      await copyObject(oldKey, newKey);
      result.copied += 1;
    }
    await apply(newKey);
    result.dbUpdated += 1;
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey }));
    console.log(`[migrate-raw-keys] ${oldKey} -> ${newKey}`);
  } catch (err) {
    result.errors += 1;
    console.error(`[migrate-raw-keys] ошибка для ${oldKey}:`, err);
  }
}

async function main(): Promise<void> {
  const result: MigrationResult = {
    scanned: 0,
    copied: 0,
    skippedMissing: 0,
    dbUpdated: 0,
    errors: 0,
  };

  // --- ListingImage.key ---
  const images = await prisma.listingImage.findMany({
    where: { key: { startsWith: 'raw/' } },
    select: { id: true, key: true },
  });
  for (const img of images) {
    await migrateKey(
      img.key,
      (newKey) =>
        prisma.listingImage.update({
          where: { id: img.id },
          data: { key: newKey, url: `${publicBase}/${newKey}` },
        }),
      result
    );
  }

  // --- Message.imageKey / imageThumbKey ---
  const messages = await prisma.message.findMany({
    where: {
      OR: [{ imageKey: { startsWith: 'raw/' } }, { imageThumbKey: { startsWith: 'raw/' } }],
    },
    select: { id: true, imageKey: true, imageThumbKey: true },
  });
  for (const msg of messages) {
    await migrateKey(
      msg.imageKey,
      (newKey) => prisma.message.update({ where: { id: msg.id }, data: { imageKey: newKey } }),
      result
    );
    await migrateKey(
      msg.imageThumbKey,
      (newKey) => prisma.message.update({ where: { id: msg.id }, data: { imageThumbKey: newKey } }),
      result
    );
  }

  // --- User.avatarUrl (хранится полным URL) ---
  const users = await prisma.user.findMany({
    where: { avatarUrl: { startsWith: `${publicBase}/raw/` } },
    select: { id: true, avatarUrl: true },
  });
  for (const user of users) {
    const rawKey = user.avatarUrl!.slice(publicBase.length + 1);
    await migrateKey(
      rawKey,
      (newKey) => prisma.user.update({ where: { id: user.id }, data: { avatarUrl: `${publicBase}/${newKey}` } }),
      result
    );
  }

  console.log('[migrate-raw-keys] итог:', result);
}

main()
  .catch((err) => {
    console.error('[migrate-raw-keys] фатальная ошибка:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
