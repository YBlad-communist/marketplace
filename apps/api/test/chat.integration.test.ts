import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';

const app = createApp();

const phone = `+7${Date.now().toString().slice(-10)}`;
const password = 'Strong123!';

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

let buyerToken = '';
let sellerToken = '';
let listingId = '';
let categoryId = '';

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'services' } });
  categoryId = cat?.id ?? '';

  await request(app).post('/api/auth/register').send({ name: 'Покупатель', phone, password, confirmPassword: password });
  const buyer = await request(app).post('/api/auth/login').send({ phone, password });
  buyerToken = buyer.body.data.accessToken;

  const sellerPhone = `+7${Date.now().toString().slice(-9)}`;
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Продавец', phone: sellerPhone, password, confirmPassword: password });
  const seller = await request(app)
    .post('/api/auth/login')
    .send({ phone: sellerPhone, password });
  sellerToken = seller.body.data.accessToken;

  const create = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Услуга для чата', description: 'Описание услуги для проверки чата', price: 50, categoryId, city: 'Казань' });
  listingId = create.body.data.listing.id;
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('chat (integration)', () => {
  it('creates conversation and sends messages', async () => {
    const conv = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId });
    expect(conv.status).toBe(201);
    const conversationId = conv.body.data.conversation.id;

    const msg = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ conversationId, text: 'Здравствуйте, товар ещё актуален?' });
    expect(msg.status).toBe(201);
    expect(msg.body.data.message.text).toContain('Здравствуйте');

    const history = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(history.status).toBe(200);
    expect(history.body.data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects access to foreign conversation', async () => {    const conv = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId });
    const conversationId = conv.body.data.conversation.id;

    const strangerPhone = `+7${Date.now().toString().slice(-9)}`;
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Хакер', phone: strangerPhone, password, confirmPassword: password });
    const strangerLogin = await request(app)
      .post('/api/auth/login')
      .send({ phone: strangerPhone, password });
    const res = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${strangerLogin.body.data.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('edits own message and rejects foreign edit', async () => {
    const conv = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId });
    const conversationId = conv.body.data.conversation.id;
    const msg = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ conversationId, text: 'Исходный текст' });
    expect(msg.status).toBe(201);
    const messageId = msg.body.data.message.id;

    const edited = await request(app)
      .patch(`/api/conversations/${conversationId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ text: 'Отредактированный текст' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.message.text).toBe('Отредактированный текст');
    expect(edited.body.data.message.editedAt).toBeTruthy();

    const foreign = await request(app)
      .patch(`/api/conversations/${conversationId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ text: 'Чужое редактирование' });
    expect(foreign.status).toBe(403);
  });

  it('deletes conversation for both participants', async () => {
    const conv = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId });
    const conversationId = conv.body.data.conversation.id;
    await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ conversationId, text: 'Привет' });

    const del = await request(app)
      .delete(`/api/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(del.status).toBe(200);

    // Чат пропал для обоих: история недоступна даже продавцу.
    for (const token of [buyerToken, sellerToken]) {
      const history = await request(app)
        .get(`/api/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${token}`);
      expect(history.status).toBe(404);
    }
  });
});
