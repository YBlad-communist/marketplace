import sharp, { type Sharp } from 'sharp';
import { PutObjectCommand, S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config.js';
import { AppError, errorCodes } from '@marketplace/shared';
import { deleteObject } from '../lib/s3.js';

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

export interface ProcessedImage {
  fullKey: string;
  thumbKey: string;
  publicUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
}

export type ImageScope = 'listing' | 'avatar' | 'chat';

/**
 * Итоговые ключи обработанного изображения.
 *
 * ЖЁСТКОЕ ПРАВИЛО: результат НИКОГДА не живёт под raw/ — иначе фоновая
 * чистка cleanupOrphanedUploads (удаляет всё под raw/ старше 48ч) снесёт
 * готовые фото.
 *
 * Префиксы (аудит п.20): фото объявлений/аватаров — images/<id>.webp
 * (публичный префикс бакета), фото чатов — chat/<id>.webp (приватный
 * префикс: отдаются только через /api/files участникам диалога).
 *
 * Важно для .webp-исходников: раньше base сохранял директорию исходника,
 * fullKey совпадал с ключом загрузки, и deleteObject(исходник) удалял
 * только что сохранённый файл (см. deleteSourceAfterProcess ниже).
 */
export function deriveOutputKeys(
  sourceKey: string,
  scope: ImageScope = 'listing'
): { fullKey: string; thumbKey: string } {
  // Отбрасываем расширение и ВСЕ директории: raw/xyz.jpg -> xyz.
  const id = sourceKey.replace(/\.[a-z0-9]+$/i, '').replace(/^.*\//, '');
  const dir = scope === 'chat' ? 'chat' : 'images';
  return {
    fullKey: `${dir}/${id}.webp`,
    thumbKey: `${dir}/${id}_thumb.webp`,
  };
}

/**
 * Удаляет исходник (raw/…) после обработки — только если его ключ
 * не совпал с итоговыми (защита от deleteObject готового файла).
 */
export async function deleteSourceAfterProcess(
  sourceKey: string,
  processed: Pick<ProcessedImage, 'fullKey' | 'thumbKey'>
): Promise<void> {
  if (sourceKey === processed.fullKey || sourceKey === processed.thumbKey) return;
  await deleteObject(sourceKey);
}

/**
 * Забирает объект из S3, декодирует через sharp (защита от polyglot/изображение-вредонос),
 * удаляет EXIF/профиль, сохраняет перекодированную версию + миниатюру.
 */
export async function processImage(
  key: string,
  scope: ImageScope = 'listing',
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
    // limitInputPixels (п.22 аудита): не даём sharp аллоцировать память под
    // гигантские декодированные картинки (дефолт — 268M пикселей).
    image = sharp(buffer, { failOn: 'error', limitInputPixels: 25_000_000 });
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
    const { fullKey, thumbKey } = deriveOutputKeys(key, scope);

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


