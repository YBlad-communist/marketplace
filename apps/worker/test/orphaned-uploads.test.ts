import { describe, expect, it } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { cleanupOrphanedUploads } from '../src/orphanedUploadsCleanup.js';
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
