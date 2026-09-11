import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { prisma } from '@marketplace/db';

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

interface ImageJobData {
  key: string;
}

/** Постобработка изображения: генерация thumbnails, удаление EXIF, перекодирование. */
export async function processImageJob(data: ImageJobData): Promise<void> {
  const { key } = data;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) return;

    const image = sharp(buffer, { failOn: 'error' });
    const meta = await image.metadata();
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
      throw new Error('unsupported format');
    }

    const base = key.replace(/\.[a-z0-9]+$/i, '');
    const fullKey = `${base}.webp`;
    const thumbKey = `${base}_thumb.webp`;

    const [full, thumb] = await Promise.all([
      image.clone().rotate().resize({ width: 1600, height: 1600, fit: 'inside' }).webp({ quality: 82 }).withMetadata({ orientation: undefined }).toBuffer(),
      image.clone().rotate().resize({ width: 400, height: 400, fit: 'inside' }).webp({ quality: 75 }).withMetadata({ orientation: undefined }).toBuffer(),
    ]);

    await Promise.all([
      client.send(new PutObjectCommand({ Bucket: bucket, Key: fullKey, Body: full, ContentType: 'image/webp' })),
      client.send(new PutObjectCommand({ Bucket: bucket, Key: thumbKey, Body: thumb, ContentType: 'image/webp' })),
    ]);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);

    const fullMeta = await sharp(full).metadata();
    const listingImage = await prisma.listingImage.findFirst({ where: { key } });
    if (listingImage) {
      await prisma.listingImage.update({
        where: { id: listingImage.id },
        data: {
          key: fullKey,
          url: `${publicBase}/${fullKey}`,
          thumbUrl: `${publicBase}/${thumbKey}`,
          width: fullMeta.width ?? null,
          height: fullMeta.height ?? null,
        },
      });
    }
  } catch (err) {
    throw new Error(`image processing failed for ${key}: ${(err as Error).message}`);
  }
}
