import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';

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

// Stripe-SDK: constructEvent отдаёт событие из постановочного буфера.
const stripeEvent = vi.hoisted(() => ({ event: null as null | { type: string; id: string; data: { object: unknown } } }));
vi.mock('stripe', () => {
  class FakeStripe {
    webhooks = {
      constructEvent: vi.fn(() => stripeEvent.event),
    };
    paymentIntents = {
      create: vi.fn(async () => {
        const pi = `pi_disp_${++stripePiSeq.value}`;
        stripePis.value.push(pi);
        return { id: pi, client_secret: `${pi}_secret` };
      }),
    };
  }
  return { __esModule: true, default: FakeStripe };
});

const stripePiSeq = vi.hoisted(() => ({ value: 0 }));
const stripePis = vi.hoisted(() => ({ value: [] as string[] }));

import { handleStripeWebhook } from '../src/services/paymentService.js';

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

let sellerToken = '';
let buyerToken = '';
let categoryId = '';

async function makeOrder(keySuffix: string): Promise<{ orderId: string; listingId: string; piId: string }> {
  const listing = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: `Товар для диспута ${keySuffix}`, description: 'Описание для диспута', price: 100, categoryId, city: 'Москва' });
  const listingId = listing.body.data.listing.id as string;
  const orderRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ listingId, idempotencyKey: `disp-${unique}-${keySuffix}` });
  expect(orderRes.status).toBe(201);
  return { orderId: orderRes.body.data.order.id as string, listingId, piId: stripePis.value[stripePis.value.length - 1] };
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const sellerPhone = `+7${unique.toString().slice(-9)}3`;
  await request(app).post('/api/auth/register').send({ name: 'Продавец-диспут', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({ where: { id: seller.id }, data: { stripeAccountId: 'acct_disp', stripeOnboarded: true } });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  sellerToken = sellerLogin.body.data.accessToken as string;

  const buyerPhone = `+7${unique.toString().slice(-9)}4`;
  await request(app).post('/api/auth/register').send({ name: 'Покупатель-диспут', phone: buyerPhone, password, confirmPassword: password });
  const buyer = await request(app).post('/api/auth/login').send({ phone: buyerPhone, password });
  buyerToken = buyer.body.data.accessToken as string;
});

afterAll(async () => {
  await disconnectRedis();
});

function disputePayload(status: 'needs_response' | 'lost', seq: number, piId: string): { type: string; id: string; data: { object: unknown } } {
  return {
    type: status === 'lost' ? 'charge.dispute.closed' : 'charge.dispute.created',
    id: `evt_dsp_${unique}_${status}_${seq}`,
    data: {
      object: {
        id: `dp_${status}_${seq}`,
        amount: 10000,
        status,
        charge: 'ch_1',
        payment_intent: piId,
      },
    },
  };
}

describeInfra('dispute: чарджбэк не трогает уже выплаченные заказы', () => {
  it('диспут по RELEASED-заказу НЕ меняет статус, но уведомляет админа', async () => {
    const { orderId, listingId, piId } = await makeOrder('released');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'RELEASED' } });
    await prisma.listing.update({ where: { id: listingId }, data: { status: 'SOLD' } });
    enqueueEmailMock.mockClear();
    stripeEvent.event = disputePayload('needs_response', 1, piId);

    const res = await handleStripeWebhook(Buffer.from('payload'), 'whsec_signature');

    expect(res.handled).toBe('charge.dispute.created');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASED');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('SOLD');
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@round5.test', subject: expect.stringContaining('уже выплаченн') })
    );
  });

  it('диспут по RELEASING-заказу НЕ меняет статус (деньги ещё движутся)', async () => {
    const { orderId, piId } = await makeOrder('releasing');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'RELEASING' } });
    enqueueEmailMock.mockClear();
    stripeEvent.event = disputePayload('needs_response', 2, piId);

    const res = await handleStripeWebhook(Buffer.from('payload'), 'whsec_signature');

    expect(res.handled).toBe('charge.dispute.created');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASING');
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
  });

  it('диспут по PAID-заказу по-прежнему переводит его в DISPUTED', async () => {
    const { orderId, piId } = await makeOrder('paid');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
    enqueueEmailMock.mockClear();
    stripeEvent.event = disputePayload('needs_response', 3, piId);

    const res = await handleStripeWebhook(Buffer.from('payload'), 'whsec_signature');

    expect(res.handled).toBe('charge.dispute.created');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('DISPUTED');
    expect(enqueueEmailMock).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('Открыт спор') }));
  });

  it('закрытие проигранного спора не трогает RELEASED-заказ (спор никогда не ставился)', async () => {
    const { orderId, piId } = await makeOrder('closed');
    await prisma.order.update({ where: { id: orderId }, data: { status: 'RELEASED' } });
    enqueueEmailMock.mockClear();
    stripeEvent.event = disputePayload('lost', 4, piId);

    const res = await handleStripeWebhook(Buffer.from('payload'), 'whsec_signature');

    expect(res.handled).toBe('charge.dispute.closed');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASED');
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});