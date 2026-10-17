import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config.js';
import { isInfraAvailable } from './helpers.js';

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

let ownerToken = '';
let ownerId = '';
let strangerToken = '';
let categoryId = '';

async function makeListing(title: string, description = 'Описание товара для аудита блока 3'): Promise<string> {
  const res = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ title, description, price: 100, categoryId, city: 'Москва' });
  expect(res.status).toBe(201);
  return res.body.data.listing.id as string;
}

async function register(name: string, phone: string): Promise<string> {
  await request(app).post('/api/auth/register').send({ name, phone, password, confirmPassword: password });
  const login = await request(app).post('/api/auth/login').send({ phone, password });
  return login.body.data.accessToken as string;
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const ownerPhone = `+7${unique.toString().slice(-9)}1`;
  ownerToken = await register('Владелец-б3', ownerPhone);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { phone: ownerPhone } })).id;
  strangerToken = await register('Чужой-б3', `+7${unique.toString().slice(-9)}2`);
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('блок 3: объявления и модерация', () => {
  it('п.12: владелец переключает статус только ACTIVE↔ARCHIVED', async () => {
    const listingId = await makeListing(`Архивирование ${unique}`);

    const archive = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ARCHIVED' });
    expect(archive.status).toBe(200);
    expect(archive.body.data.listing.status).toBe('ARCHIVED');

    const unarchive = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ACTIVE' });
    expect(unarchive.status).toBe(200);
    expect(unarchive.body.data.listing.status).toBe('ACTIVE');
  });

  it('п.12: смена статуса из REJECTED владельцем -> 409', async () => {
    const bad = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Отклонённый товар аудита', description: 'Продам оружие из коллекции', price: 100, categoryId, city: 'Москва' });
    expect(bad.status).toBe(201);
    expect(bad.body.data.listing.status).toBe('REJECTED');
    const listingId = bad.body.data.listing.id as string;

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ACTIVE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(row.status).toBe('REJECTED');
  });

  it('п.12: смена статуса из PENDING владельцем -> 409', async () => {
    const listingId = await makeListing(`Пэндинг ${unique}`);
    await prisma.listing.update({ where: { id: listingId }, data: { status: 'PENDING' } });

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(409);
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(row.status).toBe('PENDING');
  });

  it('п.12: правка title запрещённым контентом уводит объявление в REJECTED', async () => {
    const listingId = await makeListing(`Правка-модерация ${unique}`);
    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Продам оружие для коллекции' });
    expect(res.status).toBe(200);
    expect(res.body.data.listing.status).toBe('REJECTED');
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(row.moderationNote).toBeTruthy();
  });

  it('п.13: чужой status=ARCHIVED в списке игнорируется (публичный ACTIVE)', async () => {
    const archivedId = await makeListing(`Скрытое ${unique}`);
    await request(app)
      .patch(`/api/listings/${archivedId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ARCHIVED' });

    const res = await request(app)
      .get('/api/listings')
      .query({ status: 'ARCHIVED', limit: 50 });
    expect(res.status).toBe(200);
    const ids = (res.body.data.items as { id: string }[]).map((l) => l.id);
    expect(ids).not.toContain(archivedId);
    for (const l of res.body.data.items as { status: string }[]) {
      expect(l.status).toBe('ACTIVE');
    }
    expect(res.body.data.items.every((l: { moderationNote?: unknown }) => !('moderationNote' in l))).toBe(true);
  });

  it('п.13: чужой sellerId видит только ACTIVE, владелец — все статусы', async () => {
    const archivedId = await makeListing(`Скрытое-2 ${unique}`);
    await request(app)
      .patch(`/api/listings/${archivedId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ARCHIVED' });

    const stranger = await request(app)
      .get('/api/listings')
      .query({ sellerId: ownerId, limit: 50 });
    expect(stranger.status).toBe(200);
    const strangerIds = (stranger.body.data.items as { id: string }[]).map((l) => l.id);
    expect(strangerIds).not.toContain(archivedId);

    const owner = await request(app)
      .get('/api/listings')
      .query({ sellerId: ownerId, limit: 50 })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(owner.status).toBe(200);
    const ownerIds = (owner.body.data.items as { id: string }[]).map((l) => l.id);
    expect(ownerIds).toContain(archivedId);

    const ownerFiltered = await request(app)
      .get('/api/listings')
      .query({ sellerId: ownerId, status: 'ARCHIVED', limit: 50 })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerFiltered.status).toBe(200);
    const filteredItems = ownerFiltered.body.data.items as { id: string; status: string }[];
    expect(filteredItems.map((l) => l.id)).toContain(archivedId);
    for (const l of filteredItems) expect(l.status).toBe('ARCHIVED');
  });

  it('п.13: чужой favoritesOf игнорируется (публичный список), свой — работает', async () => {
    // Стороннее объявление: владелец кладёт его в избранное, чужак его не видит
    // по фильтру (фильтр чужому игнорируется → публичный ACTIVE-список со всем подряд).
    const strangerListing = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ title: `Избранное-чужое ${unique}`, description: 'Описание чужого товара для теста избранного', price: 100, categoryId, city: 'Москва' });
    expect(strangerListing.status).toBe(201);
    const favId = strangerListing.body.data.listing.id as string;
    const fav = await request(app)
      .post(`/api/listings/${favId}/favorite`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(fav.status).toBe(200);

    // Свежее объявление владельца, НЕ в избранном у чужака: маркер того, что
    // чужой favoritesOf был отброшен и пришёл публичный список.
    const notFavoritedId = await makeListing(`Не-в-избранном ${unique}`);

    const own = await request(app)
      .get('/api/listings')
      .query({ favoritesOf: ownerId, limit: 50 })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(own.status).toBe(200);
    const ownIds = (own.body.data.items as { id: string }[]).map((l) => l.id);
    expect(ownIds).toContain(favId);
    expect(ownIds).not.toContain(notFavoritedId);

    const stranger = await request(app)
      .get('/api/listings')
      .query({ favoritesOf: ownerId, limit: 50 });
    expect(stranger.status).toBe(200);
    const strangerIds = (stranger.body.data.items as { id: string }[]).map((l) => l.id);
    // Фильтр чужого игнорируется → публичный список, где свежее объявление есть.
    expect(strangerIds).toContain(notFavoritedId);
  });

  it('п.13: GET /:id не-ACTIVE скрыт от чужака (404), доступен владельцу', async () => {
    const archivedId = await makeListing(`Скрытое-3 ${unique}`);
    await request(app)
      .patch(`/api/listings/${archivedId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ARCHIVED' });

    const stranger = await request(app)
      .get(`/api/listings/${archivedId}`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(stranger.status).toBe(404);

    const anon = await request(app).get(`/api/listings/${archivedId}`);
    expect(anon.status).toBe(404);

    const owner = await request(app)
      .get(`/api/listings/${archivedId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(owner.status).toBe(200);
    expect(owner.body.data.listing.status).toBe('ARCHIVED');
  });

  it('п.13: moderationNote из detail удаляется для чужака (ACTIVE со старой заметкой)', async () => {
    const listingId = await makeListing(`Со-заметкой ${unique}`);
    await prisma.listing.update({
      where: { id: listingId },
      data: { moderationNote: 'внутренняя заметка модерации' },
    });

    const stranger = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(stranger.status).toBe(200);
    expect(stranger.body.data.listing.moderationNote).toBeUndefined();

    const owner = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(owner.status).toBe(200);
    expect(owner.body.data.listing.moderationNote).toBe('внутренняя заметка модерации');
  });

  it('п.14: images/done отклоняет фото сверх LISTING_IMAGE_LIMIT (409)', async () => {
    const listingId = await makeListing(`Лимит-фото ${unique}`);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      listingId,
      key: `images/quota-${unique}-${i}.webp`,
      url: `http://localhost:9000/marketplace/images/quota-${unique}-${i}.webp`,
      position: i,
    }));
    await prisma.listingImage.createMany({ data: rows });

    const res = await request(app)
      .post(`/api/listings/${listingId}/images/done`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ imageKeys: [{ key: `raw/quota-${unique}-overflow.jpg`, position: 20 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Максимум');
    await prisma.listingImage.deleteMany({ where: { listingId } });
  });

  it('п.15: q с % не ведёт себя как wildcard в ILIKE', async () => {
    const markerTitle = `Обычный товар без меток ${unique}`;
    const markerId = await makeListing(markerTitle);

    const res = await request(app)
      .get('/api/listings')
      .query({ q: '%', limit: 50 });
    expect(res.status).toBe(200);
    const ids = (res.body.data.items as { id: string }[]).map((l) => l.id);
    // Экранированный % ищет литеральный символ процента — маркер без него не матчится.
    expect(ids).not.toContain(markerId);
    expect(ids.length).toBeLessThan(50);
  });

  it('п.15: длинный q обрезается до 100 символов (200, не 400)', async () => {
    const res = await request(app)
      .get('/api/listings')
      .query({ q: 'а'.repeat(150) });
    expect(res.status).toBe(200);
  });

  it('п.15: ipRateLimit на поиск — 61-й запрос за минуту -> 429', async () => {
    env.RATE_LIMIT_ENABLED = true;
    try {
      let last = 0;
      // До 130 запросов: граница минутного бакета может переехать посередине
      // цикла и обнулить счётчик — тогда нужен второй заход.
      for (let i = 0; i < 130; i += 1) {
        const res = await request(app).get('/api/listings').query({ limit: 1 });
        last = res.status;
        if (res.status === 429) break;
      }
      expect(last).toBe(429);
    } finally {
      env.RATE_LIMIT_ENABLED = false;
    }
  });
});
