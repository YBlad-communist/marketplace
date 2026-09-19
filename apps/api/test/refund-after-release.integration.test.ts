import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';

// ADMIN_EMAIL нужен до загрузки config.ts: notifyAdmin без него молчит.
vi.hoisted(() => {
  process.env.ADMIN_EMAIL = 'admin@round5.test';
});

const enqueueEmailMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../src/services/notificationService.js', () => ({
  enqueueEmail: enqueueEmailMock,
  enqueueSms: vi.fn(async () => undefined),
  enqueueImageProcess: vi.fn(async () => undefined),
  enqueueSavedSearchCheck: vi.fn(async () => undefined),
  enqueueTokenCleanup: vi.fn(async () => undefined),
  enqueueExpiredHoldsCheck: vi.fn(async () => undefined),
  enqueueReleasingRecovery: vi.fn(async () => undefined),
  enqueueS3Delete: vi.fn(async () => undefined),
}));

import { handleYookassaNotification } from '../src/services/paymentService.js';

const fake = installYookassaFake({ createStatus: 'waiting_for_capture' });

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

let sellerToken = '';
let buyerToken = '';
let categoryId = '';
let refundSeq = 0;

async function makeOrder(keySuffix: string): Promise<{ orderId: string; listingId: string; paymentId: string }> {
  const listing = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: `Товар для возврата ${keySuffix}`, description: 'Описание для возврата после выплаты', price: 100, categoryId, city: 'Москва' });
  const listingId = listing.body.data.listing.id as string;
  const orderRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ listingId, idempotencyKey: `refund-after-${unique}-${keySuffix}` });
  expect(orderRes.status).toBe(201);
  return {
    orderId: orderRes.body.data.order.id as string,
    listingId,
    paymentId: fake.lastPaymentId(),
  };
}

function refundNotification(paymentId: string, refundId: string) {
  return Buffer.from(
    JSON.stringify({
      type: 'notification',
      event: 'refund.succeeded',
      object: {
        id: refundId,
        status: 'succeeded',
        payment_id: paymentId,
        amount: { value: '100.00', currency: 'RUB' },
      },
    })
  );
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const sellerPhone = `+7${unique.toString().slice(-9)}3`;
  await request(app).post('/api/auth/register').send({ name: 'Продавец-возврат', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({ where: { id: seller.id }, data: { yookassaShopId: 'shop_after', yookassaOnboarded: true } });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  sellerToken = sellerLogin.body.data.accessToken as string;

  const buyerPhone = `+7${unique.toString().slice(-9)}4`;
  await request(app).post('/api/auth/register').send({ name: 'Покупатель-возврат', phone: buyerPhone, password, confirmPassword: password });
  const buyer = await request(app).post('/api/auth/login').send({ phone: buyerPhone, password });
  buyerToken = buyer.body.data.accessToken as string;
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('refund после выплаты: вебхук возврата не трогает уже выплаченные заказы', () => {
  it('возврат по RELEASED-заказу НЕ меняет статус, но уведомляет админа', async () => {
    const { orderId, listingId, paymentId } = await makeOrder('released');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'RELEASED' } });
    await prisma.listing.update({ where: { id: listingId }, data: { status: 'SOLD' } });
    enqueueEmailMock.mockClear();

    const res = await handleYookassaNotification(refundNotification(paymentId, `refund_rel_${unique}_${++refundSeq}`));

    expect(res.handled).toBe('refund.succeeded');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASED');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('SOLD');
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@round5.test', subject: expect.stringContaining('уже выплаченной') })
    );
  });

  it('возврат по RELEASING-заказу НЕ меняет статус (деньги ещё движутся)', async () => {
    const { orderId, paymentId } = await makeOrder('releasing');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'RELEASING' } });
    enqueueEmailMock.mockClear();

    const res = await handleYookassaNotification(refundNotification(paymentId, `refund_releasing_${unique}_${++refundSeq}`));

    expect(res.handled).toBe('refund.succeeded');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASING');
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
  });

  it('возврат по PAID-заказу переводит его в REFUNDED и возвращает объявление в выдачу', async () => {
    const { orderId, listingId, paymentId } = await makeOrder('paid');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
    enqueueEmailMock.mockClear();

    const res = await handleYookassaNotification(refundNotification(paymentId, `refund_paid_${unique}_${++refundSeq}`));

    expect(res.handled).toBe('refund.succeeded');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('REFUNDED');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('ACTIVE');
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it('повторная доставка того же уведомления игнорируется (dedupe)', async () => {
    const { orderId, paymentId } = await makeOrder('dedupe');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'RELEASED' } });
    const refundId = `refund_dup_${unique}_${++refundSeq}`;
    await handleYookassaNotification(refundNotification(paymentId, refundId));
    enqueueEmailMock.mockClear();

    const res = await handleYookassaNotification(refundNotification(paymentId, refundId));

    expect(res.handled).toBe('duplicate');
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});
