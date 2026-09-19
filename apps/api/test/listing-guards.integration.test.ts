import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';

installYookassaFake({ createStatus: 'waiting_for_capture' });

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

let sellerToken = '';
let buyerToken = '';
let listingId = '';
let cleanListingId = '';
let listingIds: string[] = [];

async function makeListing(title: string): Promise<string> {
  const res = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title, description: 'Описание товара для guard-теста', price: 100, categoryId: (await prisma.category.findFirst({ where: { slug: 'services' } }))?.id, city: 'Москва' });
  expect(res.status).toBe(201);
  return res.body.data.listing.id as string;
}

beforeAll(async () => {
  await connectRedis();
  const sellerPhone = `+7${unique.toString().slice(-9)}2`;
  await request(app).post('/api/auth/register').send({ name: 'Продавец-guard', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({ where: { id: seller.id }, data: { yookassaShopId: 'shop_guard', yookassaOnboarded: true } });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  sellerToken = sellerLogin.body.data.accessToken as string;

  const buyerPhone = `+7${unique.toString().slice(-9)}3`;
  await request(app).post('/api/auth/register').send({ name: 'Покупатель-guard', phone: buyerPhone, password, confirmPassword: password });
  const buyer = await request(app).post('/api/auth/login').send({ phone: buyerPhone, password });
  buyerToken = buyer.body.data.accessToken as string;

  for (let i = 0; i < 4; i += 1) listingIds.push(await makeListing(`Объявление guard ${unique}-${i}`));
  cleanListingId = await makeListing(`Объявление без заказов ${unique}`);
});

afterAll(async () => {
  await disconnectRedis();
});

async function placeOrder(inKey: string, listingId: string): Promise<string> {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ listingId, idempotencyKey: inKey });
  expect(res.status).toBe(201);
  return res.body.data.order.id as string;
}

describeInfra('объявления: активный заказ блокирует правки и удаление', () => {
  it('PATCH цены при активном заказе -> 409 (цена = часть эскроу)', async () => {
    listingId = listingIds.shift() as string;
    const orderId = await placeOrder(`guard-${unique}-p1`, listingId);

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price: 999 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    await prisma.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
  });

  it('PATCH статуса при активном заказе -> 409', async () => {
    listingId = listingIds.shift() as string;
    const orderId = await placeOrder(`guard-${unique}-st`, listingId);
    await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(409);

    await prisma.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
  });

  it('PATCH не-финансовых полей при активном заказе проходит', async () => {
    listingId = listingIds.shift() as string;
    const orderId = await placeOrder(`guard-${unique}-ok`, listingId);

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ description: 'Новое описание товара без влияния на эскроу' });
    expect(res.status).toBe(200);

    await prisma.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
  });

  it('DELETE при активном заказе (PENDING) -> 409 и объявление цело', async () => {
    listingId = listingIds.shift() as string;
    await placeOrder(`guard-${unique}-del`, listingId);

    const res = await request(app)
      .delete(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    expect(listing).not.toBeNull();
    expect(listing?.status).toBe('RESERVED');
  });

  it('DELETE после закрытия заказа (REFUNDED) отклоняется: история заказов не стирается', async () => {
    // переиспользуем объявление из прошлого шага: заказ переведён в REFUNDED —
    // активного нет, но RESTRICT-FK хранит историю эскроу, поэтому 409.
    const orders = await prisma.order.findMany({ where: { listingId } });
    for (const o of orders) {
      await prisma.order.update({ where: { id: o.id }, data: { status: 'REFUNDED' } });
    }
    await prisma.listing.update({ where: { id: listingId }, data: { status: 'ACTIVE' } });

    const res = await request(app)
      .delete(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(await prisma.listing.findUnique({ where: { id: listingId } })).not.toBeNull();
  });

  it('DELETE объявления без заказов проходит', async () => {
    const res = await request(app)
      .delete(`/api/listings/${cleanListingId}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    expect(await prisma.listing.findUnique({ where: { id: cleanListingId } })).toBeNull();
  });
});