import { describe, expect, it } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { cleanupOrphanedUploads } from '../src/orphanedUploadsCleanup.js';
import { processImageJob } from '../src/imageJob.js';
import { getS3Client } from '../src/lib/s3.js';
import { env } from '../src/config.js';

async function s3Available(): Promise<boolean> {
  try {
    await Promise.race([
      getS3Client().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: '__probe__' })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('s3 timeout')), 5000)),
    ]);
    return true;
  } catch (err) {
    // HeadObject на отсутствующий ключ кидает NotFound (имя ошибки, не текст) —
    // это тоже «S3 доступен».
    const hay = `${err instanceof Error ? err.name : ''} ${err instanceof Error ? err.message : ''}`;
    if (/not ?found|NoSuchKey/i.test(hay)) return true;
    return false;
  }
}

const s3up = await s3Available();
const describeS3 = s3up ? describe : describe.skip;

async function exists(key: string): Promise<boolean> {
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

describeS3('orphaned uploads cleanup (s3)', () => {
  it('удаляет брошенный raw/-объект и не трогает подтверждённый', async () => {
    const stamp = Date.now();
    const orphanKey = `raw/orphan-test-${stamp}.bin`;
    const keptKey = `listings/keep-test-${stamp}.webp`;

    await getS3Client().send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: orphanKey, Body: Buffer.from('orphan') })
    );
    await getS3Client().send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: keptKey, Body: Buffer.from('kept') })
    );
    expect(await exists(orphanKey)).toBe(true);

    // Подтверждённое фото: сырого ключа уже нет (удалён при confirm), живёт не под raw/.
    const rawOfKept = await getS3Client()
      .send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: keptKey }))
      .then(() => true)
      .catch(() => false);
    expect(rawOfKept).toBe(true);

    const result = await cleanupOrphanedUploads(0);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await exists(orphanKey)).toBe(false);
    expect(await exists(keptKey)).toBe(true);

    await getS3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: keptKey }));
  });
});

async function dbAvailable(): Promise<boolean> {
  try {
    const { prisma } = await import('@marketplace/db');
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const dbup = s3up && (await dbAvailable());
const describeFull = dbup ? describe : describe.skip;

/**
 * Регрессия «потери данных»: processImageJob кладёт итоговые webp под
 * images/ (не raw/), поэтому cleanupOrphanedUploads (сносит raw/ старше grace)
 * не удаляет готовые фото. До фикса итог писался в raw/<id>.webp и через
 * 48 часов уничтожался чисткой.
 */
describeFull('processImageJob + cleanupOrphanedUploads (s3+db)', () => {
  it('jpg и webp: готовые фото переживают чистку raw/', async () => {
    const stamp = Date.now();
    const jpegKey = `raw/photo-jpg-${stamp}.jpg`;
    const webpKey = `raw/photo-webp-${stamp}.webp`;

    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg()
      .toBuffer();
    const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 200, b: 30 } } })
      .webp()
      .toBuffer();

    await getS3Client().send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: jpegKey, Body: jpeg, ContentType: 'image/jpeg' }));
    await getS3Client().send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: webpKey, Body: webp, ContentType: 'image/webp' }));

    await processImageJob({ key: jpegKey });
    await processImageJob({ key: webpKey });

    const jpegFull = `images/photo-jpg-${stamp}.webp`;
    const jpegThumb = `images/photo-jpg-${stamp}_thumb.webp`;
    const webpFull = `images/photo-webp-${stamp}.webp`;
    const webpThumb = `images/photo-webp-${stamp}_thumb.webp`;

    // Готовые файлы — под images/, не под raw/.
    expect(await exists(jpegFull)).toBe(true);
    expect(await exists(jpegThumb)).toBe(true);
    expect(await exists(webpFull)).toBe(true);
    expect(await exists(webpThumb)).toBe(true);
    // Исходники удалены после обработки (ключи отличались).
    expect(await exists(jpegKey)).toBe(false);
    expect(await exists(webpKey)).toBe(false);

    // Чистка сносит всё под raw/ (grace=0) — готовые фото не пострадали.
    await cleanupOrphanedUploads(0);
    expect(await exists(jpegFull)).toBe(true);
    expect(await exists(jpegThumb)).toBe(true);
    expect(await exists(webpFull)).toBe(true);
    expect(await exists(webpThumb)).toBe(true);

    for (const k of [jpegFull, jpegThumb, webpFull, webpThumb]) {
      await getS3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: k }));
    }
  });
});
