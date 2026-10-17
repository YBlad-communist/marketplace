import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  GetBucketPolicyCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { env, filesBaseUrl } from '../src/config.js';
import { processImage } from '../src/services/imageService.js';
import { isInfraAvailable } from './helpers.js';

// П.18/п.21: перехватываем фоновое удаление файлов из S3 — тесты проверяют,
// КАКИЕ ключи попадают в очередь (и попадают ли вообще).
vi.mock('../src/services/notificationService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/notificationService.js')>();
  return { ...actual, enqueueS3Delete: vi.fn(async () => undefined) };
});

import { enqueueS3Delete } from '../src/services/notificationService.js';

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});
const bucket = env.S3_BUCKET;
const s3Root = `${env.S3_ENDPOINT.replace(/\/+$/, '')}/${bucket}`;

let buyerToken = '';
let buyerId = '';
let sellerToken = '';
let sellerId = '';
let strangerToken = '';
let conversationId = '';
let categoryId = '';

const pubKey = `images/storage-audit-${unique}.webp`;
const chatKey = `chat/storage-audit-${unique}.webp`;
const legacyChatKey = `images/storage-audit-legacy-${unique}.webp`;
const disputeKey = `raw/storage-audit-dispute-${unique}.jpg`;
const rawNotDisputeKey = `raw/storage-audit-free-${unique}.jpg`;

async function register(name: string, phone: string): Promise<{ token: string; userId: string }> {
  await request(app).post('/api/auth/register').send({ name, phone, password, confirmPassword: password });
  const login = await request(app).post('/api/auth/login').send({ phone, password });
  return { token: login.body.data.accessToken as string, userId: login.body.data.user.id as string };
}

async function putObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

/** supertest отдаёт бинарь в res.body (Buffer), текст — в res.text. */
function contentOf(res: { body: unknown; text?: string }): string {
  if (Buffer.isBuffer(res.body)) return res.body.toString();
  if (typeof res.text === 'string' && res.text.length > 0) return res.text;
  return '';
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

let originalPolicy: string | null = null;

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const buyer = await register('Покупатель-б4', `+7${unique.toString().slice(-9)}1`);
  buyerToken = buyer.token;
  buyerId = buyer.userId;
  const seller = await register('Продавец-б4', `+7${unique.toString().slice(-9)}2`);
  sellerToken = seller.token;
  sellerId = seller.userId;
  const stranger = await register('Чужой-б4', `+7${unique.toString().slice(-9)}3`);
  strangerToken = stranger.token;

  const conv = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ recipientId: sellerId });
  conversationId = conv.body.data.conversation.id as string;

  // Фото-сообщение в чате: ключи приватны, отдаются только через /api/files.
  await prisma.message.create({
    data: { conversationId, senderId: buyerId, text: 'Фото чата', imageKey: chatKey, imageThumbKey: `${chatKey}_thumb` },
  });

  await putObject(pubKey, 'public-image-bytes', 'image/webp');
  await putObject(chatKey, 'chat-image-bytes', 'image/webp');
  await putObject(legacyChatKey, 'legacy-chat-bytes', 'image/webp');
  await putObject(disputeKey, 'dispute-photo-bytes', 'image/jpeg');
  await putObject(rawNotDisputeKey, 'random-upload-bytes', 'image/jpeg');

  // Приватный бакет (п.20): анонимам открыт только чтение images/, без
  // ListBucket — та же политика, что прописана в docker-compose.yml.
  try {
    const res = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    originalPolicy = res.Policy ?? null;
  } catch {
    originalPolicy = null;
  }
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: [`arn:aws:s3:::${bucket}/images/*`] },
        ],
      }),
    })
  );
});

afterAll(async () => {
  if (originalPolicy) {
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: originalPolicy })).catch(() => undefined);
  } else {
    await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket })).catch(() => undefined);
  }
  for (const key of [pubKey, chatKey, legacyChatKey, disputeKey, rawNotDisputeKey]) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
  }
  await disconnectRedis();
});

beforeEach(() => {
  vi.mocked(enqueueS3Delete).mockClear();
});

describeInfra('блок 4: файлы и хранилище', () => {
  it('п.18: PATCH /me принимает только avatarUrl -> 400 (аватар меняется через /me/avatar/confirm)', async () => {
    const user = await register('Аватар-патч1', `+7${unique.toString().slice(-9)}4`);
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ avatarUrl: 'https://evil.example/steal.webp' });
    expect(res.status).toBe(400);
    const row = await prisma.user.findUnique({ where: { id: user.userId } });
    expect(row?.avatarUrl).toBeNull();
  });

  it('п.18: PATCH /me вместе с name молча игнорирует avatarUrl', async () => {
    const user = await register('Аватар-патч2', `+7${unique.toString().slice(-9)}5`);
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Новое Имя', avatarUrl: 'https://evil.example/steal.webp' });
    expect(res.status).toBe(200);
    const row = await prisma.user.findUnique({ where: { id: user.userId } });
    expect(row?.name).toBe('Новое Имя');
    expect(row?.avatarUrl).toBeNull();
  });

  it('п.18: при удалении аккаунта отравленный avatarUrl не превращается в удаление чужого файла', async () => {
    const poison = await register('Удаление-яд', `+7${unique.toString().slice(-9)}6`);
    await prisma.user.update({
      where: { id: poison.userId },
      data: { avatarUrl: `${env.S3_PUBLIC_BASE_URL}/images/listings/victim-photo.webp` },
    });
    const res = await request(app)
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${poison.token}`)
      .send({ password });
    expect(res.status).toBe(200);
    expect(vi.mocked(enqueueS3Delete)).not.toHaveBeenCalled();
  });

  it('п.18: при удалении аккаунта корректный ключ аватара (формат сервера) уходит в очередь', async () => {
    const own = await register('Удаление-аватар', `+7${unique.toString().slice(-9)}7`);
    const validAvatarKey = 'images/AbCdEfGh12345678.webp';
    await prisma.user.update({
      where: { id: own.userId },
      data: { avatarUrl: `${env.S3_PUBLIC_BASE_URL}/${validAvatarKey}` },
    });
    const res = await request(app)
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${own.token}`)
      .send({ password });
    expect(res.status).toBe(200);
    expect(vi.mocked(enqueueS3Delete)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueS3Delete)).toHaveBeenCalledWith([validAvatarKey]);
  });

  it('п.20: docker-compose без mc anonymous set download, политика только на images/* без ListBucket', () => {
    const composePath = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url));
    const compose = readFileSync(composePath, 'utf8');
    expect(compose).not.toContain('mc anonymous set download');
    expect(compose).toContain('mc anonymous set-json');
    expect(compose).not.toContain('ListBucket');
    expect(compose).toContain('marketplace/images/*');
  });

  it('п.20: анонимный прямой доступ к MinIO открыт только для images/', async () => {
    const pub = await fetch(`${s3Root}/${pubKey}`);
    expect(pub.status).toBe(200);
    const chat = await fetch(`${s3Root}/${chatKey}`);
    expect(chat.status).toBe(403);
    // ListBucket анонимам закрыт.
    const list = await fetch(`${s3Root}/`);
    expect(list.status).toBe(403);
  });

  it('п.20: /api/files отдаёт public-картинку анонимно, чат — только участникам', async () => {
    const pub = await request(app).get(`/api/files/${pubKey}`);
    expect(pub.status).toBe(200);
    expect(contentOf(pub)).toBe('public-image-bytes');

    const anon = await request(app).get(`/api/files/${chatKey}`);
    expect(anon.status).toBe(401);

    const participant = await request(app)
      .get(`/api/files/${chatKey}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(participant.status).toBe(200);
    expect(contentOf(participant)).toBe('chat-image-bytes');

    const stranger = await request(app)
      .get(`/api/files/${chatKey}`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(stranger.status).toBe(403);
  });

  it('п.20: legacy-ключ фото чата под images/ тоже закрыт для посторонних', async () => {
    await prisma.message.create({
      data: { conversationId, senderId: buyerId, text: 'Старое фото', imageKey: legacyChatKey },
    });
    const anon = await request(app).get(`/api/files/${legacyChatKey}`);
    expect(anon.status).toBe(401);
    const owner = await request(app)
      .get(`/api/files/${legacyChatKey}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(owner.status).toBe(200);
    const stranger = await request(app)
      .get(`/api/files/${legacyChatKey}`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(stranger.status).toBe(403);
  });

  it('п.20: raw/ не отдаётся без привязки к спору; фото спора — сторонам и модераторам', async () => {
    const listing = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Товар для фото спора', description: 'Описание товара спора', price: 100, categoryId, city: 'Москва' });
    expect(listing.status).toBe(201);
    const order = await prisma.order.create({
      data: { listingId: listing.body.data.listing.id, buyerId, amount: 100, status: 'SHIPPED' },
    });
    await prisma.dispute.create({
      data: { orderId: order.id, openedById: buyerId, reason: 'Фото не пришли', photos: [disputeKey] },
    });

    // Анониму без токена — 401 (спор найден, авторизация отсутствует).
    const anon = await request(app).get(`/api/files/${disputeKey}`);
    expect(anon.status).toBe(401);

    // raw/-ключ вне спора не выдаётся никому.
    const free = await request(app)
      .get(`/api/files/${rawNotDisputeKey}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(free.status).toBe(403);

    const buyer = await request(app)
      .get(`/api/files/${disputeKey}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(buyer.status).toBe(200);
    expect(contentOf(buyer)).toBe('dispute-photo-bytes');

    const seller = await request(app)
      .get(`/api/files/${disputeKey}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(seller.status).toBe(200);

    const stranger = await request(app)
      .get(`/api/files/${disputeKey}`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(stranger.status).toBe(403);
  });

  it('п.20: подделанные ключи (.., чужие префиксы) не проходят', async () => {
    const traversal = await request(app).get('/api/files/images/%2e%2e%2fsecret');
    expect(traversal.status).toBe(403);
    const other = await request(app).get('/api/files/backups/db.sql');
    expect(other.status).toBe(403);
    const unknownChat = await request(app).get(`/api/files/chat/nope-${unique}.webp`);
    expect(unknownChat.status).toBe(403);
  });

  it('п.20: URL фото сообщений указывают на приватный прокси /api/files', async () => {
    await prisma.message.create({
      data: { conversationId, senderId: buyerId, text: 'Фото в чате', imageKey: chatKey, imageThumbKey: `${chatKey}_thumb` },
    });
    const list = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(list.status).toBe(200);
    const urls = (list.body.data.items as { imageUrl: string | null }[]).map((m) => m.imageUrl);
    expect(urls).toContain(`${filesBaseUrl}/${chatKey}`);
    expect(urls.some((u) => u?.includes('/api/files/'))).toBe(true);
  });

  it('п.21: у удалённого сообщения обнуляются imageKey/imageThumbKey/imageUrl/imageThumbUrl', async () => {
    const msg = await prisma.message.create({
      data: { conversationId, senderId: buyerId, text: 'Фото на удаление', imageKey: `${chatKey}`, imageThumbKey: `${chatKey}_thumb` },
    });
    const del = await request(app)
      .delete(`/api/conversations/${conversationId}/messages/${msg.id}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(del.status).toBe(200);

    const list = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyerToken}`);
    const item = (list.body.data.items as Record<string, unknown>[]).find((m) => m.id === msg.id);
    expect(item).toBeDefined();
    expect(item?.deletedAt).not.toBeNull();
    expect(item?.text).toBe('Сообщение удалено');
    expect(item?.imageKey).toBeNull();
    expect(item?.imageThumbKey).toBeNull();
    expect(item?.imageUrl).toBeNull();
    expect(item?.imageThumbUrl).toBeNull();
  });

  it('п.21: deleteMessage ставит удаление фото из S3 в очередь', async () => {
    const msg = await prisma.message.create({
      data: { conversationId, senderId: buyerId, text: 'Фото в очередь', imageKey: `chat/q-${unique}.webp`, imageThumbKey: `chat/q-${unique}_thumb.webp` },
    });
    const del = await request(app)
      .delete(`/api/conversations/${conversationId}/messages/${msg.id}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(del.status).toBe(200);
    expect(vi.mocked(enqueueS3Delete)).toHaveBeenCalledWith([`chat/q-${unique}.webp`, `chat/q-${unique}_thumb.webp`]);
  });

  it('п.22: presigned URL подписывает Content-Length, PUT с другим размером отклоняется', async () => {
    const res = await request(app)
      .post('/api/uploads/images/presign')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ mime: 'image/jpeg', extension: '.jpg', sizeBytes: 1000, scope: 'listing' });
    expect(res.status).toBe(200);
    const uploadUrl = res.body.data.uploadUrl as string;
    expect(uploadUrl).toMatch(/SignedHeaders=[^&]*content-length/i);

    const wrong = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.alloc(500, 7),
    });
    expect(wrong.status).toBe(403);

    const ok = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.alloc(1000, 7),
    });
    expect(ok.status).toBe(200);
    // сырой ключ убираем за собой
    const presignedKey = res.body.data.key as string;
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: presignedKey })).catch(() => undefined);
  });

  it('п.22: processImage отклоняет изображение с >25M пикселей (limitInputPixels)', async () => {
    const key = `raw/storage-big-${unique}.jpg`;
    const huge = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: { r: 180, g: 90, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    await putObject(key, huge, 'image/jpeg');
    await expect(processImage(key, 'listing')).rejects.toThrow('не является корректным изображением');
    expect(await objectExists(key)).toBe(true);
    const outputKey = `images/storage-big-${unique}.webp`;
    expect(await objectExists(outputKey)).toBe(false);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
  });

  it('п.22: userRateLimit на presign — 31-я выдача за час -> 429', async () => {
    env.RATE_LIMIT_ENABLED = true;
    try {
      const user = await register('Рейт-лимит-б4', `+7${unique.toString().slice(-9)}8`);
      let last = 0;
      // 70 запросов: граница часового бакета может переехать посередине
      // цикла и обнулить счётчик — тогда нужен второй заход.
      for (let i = 0; i < 70; i += 1) {
        const res = await request(app)
          .post('/api/uploads/images/presign')
          .set('Authorization', `Bearer ${user.token}`)
          .send({ mime: 'image/jpeg', extension: '.jpg', sizeBytes: 2048, scope: 'listing' });
        last = res.status;
        if (last === 429) break;
        expect(res.status).toBe(200);
      }
      expect(last).toBe(429);
    } finally {
      env.RATE_LIMIT_ENABLED = false;
    }
  });
});
