import { describe, expect, it } from 'vitest';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { deleteObjectsJob, isSafeDeleteKey } from '../src/s3Delete.js';
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
    const hay = `${err instanceof Error ? err.name : ''} ${err instanceof Error ? err.message : ''}`;
    if (/not ?found|NoSuchKey/i.test(hay)) return true;
    return false;
  }
}

const s3up = await s3Available();
const describeS3 = s3up ? describe : describe.skip;

describe('s3 delete: whitelist ключей (п.19)', () => {
  it('разрешает только префиксы приложения images/, raw/, chat/ без ..', () => {
    expect(isSafeDeleteKey('images/a.webp')).toBe(true);
    expect(isSafeDeleteKey('images/listings/a_thumb.webp')).toBe(true);
    expect(isSafeDeleteKey('raw/a.jpg')).toBe(true);
    expect(isSafeDeleteKey('chat/a.webp')).toBe(true);

    expect(isSafeDeleteKey('../etc/passwd')).toBe(false);
    expect(isSafeDeleteKey('images/../secret')).toBe(false);
    expect(isSafeDeleteKey('images/../../raw/x')).toBe(false);
    expect(isSafeDeleteKey('avatars/a.webp')).toBe(false);
    expect(isSafeDeleteKey('users/a.webp')).toBe(false);
    expect(isSafeDeleteKey('marketplace/images/a.webp')).toBe(false);
    expect(isSafeDeleteKey('/images/a.webp')).toBe(false);
    expect(isSafeDeleteKey('https://evil.example/a.webp')).toBe(false);
  });
});

describeS3('s3 delete: deleteObjectsJob (п.19)', () => {
  it('удаляет только безопасные ключи, остальные пропускает без ошибки', async () => {
    const result = await deleteObjectsJob({
      keys: [
        `images/del-a-${Date.now()}.webp`,
        `raw/del-b-${Date.now()}.jpg`,
        `chat/del-c-${Date.now()}.webp`,
        'avatars/del-d.webp',
        'secrets/del-e.txt',
        '../../del-f',
        'images/../../del-g',
      ],
    });
    expect(result.attempted).toBe(3);
  });

  it('бросает ошибку при пустом payload (ретрай BullMQ)', async () => {
    await expect(deleteObjectsJob({ keys: [] })).rejects.toThrow('keys required');
  });
});
