import sharp, { type Sharp } from 'sharp';
import { PutObjectCommand, S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config.js';
import { AppError, errorCodes } from '@marketplace/shared';

const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

const bucket = env.S3_BUCKET;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ProcessedImage {
  fullKey: string;
  thumbKey: string;
  publicUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
}

/**
 * Забирает объект из S3, декодирует через sharp (защита от polyglot/изображение-вредонос),
 * удаляет EXIF/профиль, сохраняет перекодированную версию + миниатюру.
 */
export async function processImage(
  key: string,
  originalUrl?: string,
  limitBytes = env.S3_MAX_IMAGE_BYTES
): Promise<ProcessedImage> {
  let buffer: Buffer;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } catch {
    throw new AppError(errorCodes.VALIDATION, 'Не удалось прочитать загруженный файл', 400);
  }

  if (buffer.length > limitBytes) {
    throw new AppError(errorCodes.VALIDATION, 'Файл слишком большой', 400);
  }

  let image: Sharp;
  try {
    image = sharp(buffer, { failOn: 'error' });
    const meta = await image.metadata();
    const format = meta.format;
    if (!format || !['jpeg', 'png', 'webp'].includes(format)) {
      throw new Error('unsupported format');
    }

    const full = await image
      .clone()
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .withMetadata({ orientation: undefined })
      .toBuffer();

    const thumb = await image
      .clone()
      .rotate()
      .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .withMetadata({ orientation: undefined })
      .toBuffer();

    const meta2 = await sharp(full).metadata();
    const base = key.replace(/\.[a-z0-9]+$/i, '');
    const fullKey = `${base}.webp`;
    const thumbKey = `${base}_thumb.webp`;

    await Promise.all([
      client.send(new PutObjectCommand({ Bucket: bucket, Key: fullKey, Body: full, ContentType: 'image/webp' })),
      client.send(new PutObjectCommand({ Bucket: bucket, Key: thumbKey, Body: thumb, ContentType: 'image/webp' })),
    ]);

    return {
      fullKey,
      thumbKey,
      publicUrl: `${env.S3_PUBLIC_BASE_URL}/${fullKey}`,
      thumbUrl: `${env.S3_PUBLIC_BASE_URL}/${thumbKey}`,
      width: meta2.width ?? 0,
      height: meta2.height ?? 0,
      mime: 'image/webp',
    };
  } catch (err) {
    throw new AppError(errorCodes.VALIDATION, 'Файл не является корректным изображением', 400);
  }
}

export function isAllowedMime(mime: string): boolean {
  return ALLOWED.has(mime);
}
