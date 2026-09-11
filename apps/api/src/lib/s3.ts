import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config.js';
import { AppError, errorCodes } from '@marketplace/shared';
import { logger } from './logger.js';

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

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
  publicUrl: string;
  expiresIn: number;
}

function randomKey(extension: string): string {
  const now = new Date();
  const date = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const id = cryptoRandom();
  return `listings/${date}/${id}${extension}`;
}

function cryptoRandom(): string {
  return randomBytes(12).toString('base64url');
}

export async function createPresignedUpload(
  mime: string,
  extension: string,
  sizeBytes: number
): Promise<PresignedUpload> {
  if (sizeBytes > env.S3_MAX_IMAGE_BYTES) {
    throw new AppError(errorCodes.VALIDATION, 'Файл слишком большой', 400);
  }
  const key = randomKey(extension);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: mime,
    ContentLength: sizeBytes,
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 60 * 15 });
  return {
    key,
    uploadUrl,
    publicUrl: `${env.S3_PUBLIC_BASE_URL}/${key}`,
    expiresIn: 60 * 15,
  };
}

export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logger.warn({ err, key }, 's3 get failed');
    return null;
  }
}

export async function headObject(key: string): Promise<{ contentType?: string; contentLength?: number } | null> {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { contentType: res.ContentType, contentLength: res.ContentLength };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    logger.warn({ err, key }, 's3 delete failed');
  }
}

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function checkKeySafe(key: string): void {
  if (!key.startsWith('listings/') || key.includes('..')) {
    throw new AppError(errorCodes.VALIDATION, 'Некорректный ключ объекта', 400);
  }
}

/** Проверка объекта после аплоада: размер, MIME и реальные габариты через sharp */
export async function verifyImageObject(key: string, expectedSizeBytes?: number): Promise<{ width: number; height: number; mime: string }> {
  checkKeySafe(key);
  const buf = await getObjectBuffer(key);
  if (!buf) {
    throw new AppError(errorCodes.VALIDATION, 'Объект не найден в хранилище', 400);
  }
  const limit = expectedSizeBytes ?? env.S3_MAX_IMAGE_BYTES;
  if (buf.length > limit) {
    await deleteObject(key).catch(() => undefined);
    throw new AppError(errorCodes.VALIDATION, 'Размер файла превышает лимит', 400);
  }
  const mime = detectMime(buf);
  if (!ALLOWED_MIMES.has(mime)) {
    await deleteObject(key).catch(() => undefined);
    throw new AppError(errorCodes.VALIDATION, `Недопустимый тип файла: ${mime}. Разрешены JPEG, PNG, WebP`, 400);
  }
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(buf, { failOn: 'error' }).metadata();
    if (!meta.width || !meta.height) {
      throw new AppError(errorCodes.VALIDATION, 'Не удалось определить размеры изображения', 400);
    }
    if (meta.width > 8000 || meta.height > 8000) {
      throw new AppError(errorCodes.VALIDATION, 'Изображение слишком большое (макс. 8000px)', 400);
    }
    return { width: meta.width, height: meta.height, mime };
  } catch (err) {
    if (err instanceof AppError) throw err;
    await deleteObject(key).catch(() => undefined);
    throw new AppError(errorCodes.VALIDATION, 'Файл повреждён или не является изображением', 400);
  }
}

export function detectMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8) {
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return 'image/png';
    }
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}
