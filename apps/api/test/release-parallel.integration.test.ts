import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';

// Считаем ВСЕ вызовы capture: двойная выплата = capture вызван
// больше одного раза на один заказ.
const fake = installYookassaFake({ createStatus: 'waiting_for_capture' });

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

let sellerToken = '';
let listingIds: string[] = [];
let buyerToken = '';

async function makePaidOrder(keySuffix: string): Promise<{ orderId: string; listingId: string }> {
  const usedListing = listingIds.shift();
  const created = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ listingId: usedListing, idempotencyKey: `par-${unique}-${keySuffix}` });
  expect(created.status).toBe(201);
  const orderId = created.body.data.order.id as string;
  await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
  return { orderId, listingId: usedListing as string };
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });

  const sellerPhone = `+7${unique.toString().slice(-9)}8`;
  await request(app).post('/api/auth/register').send({ name: 'Продавец-параллель', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({ where: { id: seller.id }, data: { yookassaShopId: 'shop_par', yookassaOnboarded: true } });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  sellerToken = sellerLogin.body.data.accessToken as string;

  const buyerPhone = `+7${unique.toString().slice(-9)}9`;
  await request(app).post('/api/auth/register').send({ name: 'Покупатель-параллель', phone: buyerPhone, password, confirmPassword: password });
  const buyer = await request(app).post('/api/auth/login').send({ phone: buyerPhone, password });
  buyerToken = buyer.body.data.accessToken as string;

  const makeListing = async (i: number) => {
    const res = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: `Товар для параллельного release ${i}`, description: 'Описание товара для параллельного теста', price: 100, categoryId: cat?.id, city: 'Москва' });
    return res.body.data.listing.id as string;
  };
  for (let i = 0; i < 6; i += 1) listingIds.push(await makeListing(i));
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('release: параллельный вызов не даёт двойной выплаты', () => {
  it('два одновременных release: один 200, второй 409, capture вызван ровно один раз', async () => {
    const { orderId, listingId } = await makePaidOrder('race');
    fake.calls.capture = 0;
    fake.calls.capturedIds = [];

    const [a, b] = await Promise.all([
      request(app).post(`/api/orders/${orderId}/release`).set('Authorization', `Bearer ${buyerToken}`),
      request(app).post(`/api/orders/${orderId}/release`).set('Authorization', `Bearer ${buyerToken}`),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASED');
    expect(Number(order.platformFee)).toBe(2);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('SOLD');
    expect(fake.calls.capture).toBe(1);
  });

  it('release уже завершённого (RELEASED) заказа идемпотентно отклоняется', async () => {
    const { orderId } = await makePaidOrder('again');
    fake.calls.capture = 0;

    const first = await request(app).post(`/api/orders/${orderId}/release`).set('Authorization', `Bearer ${buyerToken}`);
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/orders/${orderId}/release`).set('Authorization', `Bearer ${buyerToken}`);
    expect(second.status).toBe(409);
    expect(fake.calls.capture).toBe(1);
  });

  it('refund заказа в RELEASING запрещён (деньги движутся к продавцу)', async () => {
    const { orderId } = await makePaidOrder('refundguard');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'RELEASING' } });
    fake.calls.cancel = 0;
    fake.calls.refund = 0;

    const res = await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASING');
    expect(fake.calls.cancel).toBe(0);
    expect(fake.calls.refund).toBe(0);
  });
});
