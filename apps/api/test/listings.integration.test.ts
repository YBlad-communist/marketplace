import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '@marketplace/db';
import { connectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';

const app = createApp();

const phone = `+7${Date.now().toString().slice(-10)}`;
const password = 'Strong123!';

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

let accessToken = '';
let categoryId = '';

async function registerSeller() {
  await request(app).post('/api/auth/register').send({
    name: 'Продавец',
    phone,
    password,
    confirmPassword: password,
  });
  const login = await request(app).post('/api/auth/login').send({ phone, password });
  accessToken = login.body.data.accessToken;
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';
  await registerSeller();
});

describeInfra('listings (integration)', () => {
  it('creates a listing and finds it by search', async () => {
    const create = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Интеграционный тест смартфон',
        description: 'Тестовый смартфон для интеграционного прогона',
        price: 250,
        categoryId,
        city: 'Москва',
      });
    expect(create.status).toBe(201);
    const listingId = create.body.data.listing.id;

    const search = await request(app).get('/api/listings').query({ q: 'смартфон', city: 'Москва' });
    expect(search.status).toBe(200);
    const found = search.body.data.items.find((l: { id: string }) => l.id === listingId);
    expect(found).toBeTruthy();

    const detail = await request(app).get(`/api/listings/${listingId}`);
    expect(detail.status).toBe(200);
    expect(typeof detail.body.data.listing.viewsCount).toBe('number');
    // Счётчик инкрементится после ответа (защита от накрутки по ip/user),
    // поэтому актуальное значение возвращается со второго запроса.
    const detailAgain = await request(app).get(`/api/listings/${listingId}`);
    expect(detailAgain.body.data.listing.viewsCount).toBeGreaterThanOrEqual(1);
  });

  it('allows only owner to edit', async () => {
    const create = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Второй тестовый товар',
        description: 'Описание второго товара для проверки прав',
        price: 100,
        categoryId,
        city: 'Санкт-Петербург',
      });
    const listingId = create.body.data.listing.id;

    const strangerPhone = `+7${Date.now().toString().slice(-9)}`;
    await request(app).post('/api/auth/register').send({
      name: 'Чужой',
      phone: strangerPhone,
      password,
      confirmPassword: password,
    });
    const strangerLogin = await request(app).post('/api/auth/login').send({
      phone: strangerPhone,
      password,
    });

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${strangerLogin.body.data.accessToken}`)
      .send({ title: 'Хакнул' });
    expect(res.status).toBe(403);
  });

  it('filters by price range', async () => {
    const res = await request(app)
      .get('/api/listings')
      .query({ minPrice: 200, maxPrice: 300 });
    expect(res.status).toBe(200);
    for (const l of res.body.data.items) {
      expect(Number(l.price)).toBeGreaterThanOrEqual(200);
      expect(Number(l.price)).toBeLessThanOrEqual(300);
    }
  });
});
