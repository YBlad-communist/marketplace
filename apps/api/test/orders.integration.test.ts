import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';

// Мокаем сам Stripe-SDK, а не createEscrowOrder: сервис остаётся настоящим,
// чтобы проверки (идемпотентность, «второй заказ на то же объявление») были честными.
vi.mock('stripe', () => {
  class FakeStripe {
    paymentIntents = {
      create: vi.fn(async () => ({ id: 'pi_3_mock', client_secret: 'pi_3_secret_test' })),
      retrieve: vi.fn(async () => ({ id: 'pi_3_mock', client_secret: 'pi_3_secret_test' })),
      capture: vi.fn(async () => ({ status: 'succeeded' })),
      cancel: vi.fn(async () => ({})),
    };
    transfers = {
      create: vi.fn(async () => ({ id: 'tr_1_mock' })),
    };
  }
  return { __esModule: true, default: FakeStripe };
});

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
let buyerToken = '';
let categoryId = '';
let listingId = '';

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const sellerPhone = `+7${Date.now().toString().slice(-9)}4`;
  await request(app).post('/api/auth/register').send({ name: 'Продавец', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({
    where: { id: seller.id },
    data: { stripeAccountId: 'acct_test', stripeOnboarded: true },
  });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  const sellerToken = sellerLogin.body.data.accessToken as string;

  const buyerPhone = `+7${Date.now().toString().slice(-9)}5`;
  await request(app).post('/api/auth/register').send({ name: 'Покупатель', phone: buyerPhone, password, confirmPassword: password });
  const buyer = await request(app).post('/api/auth/login').send({ phone: buyerPhone, password });
  buyerToken = buyer.body.data.accessToken;

  const create = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Товар для оплаты', description: 'Описание товара для проверки оплаты', price: 100, categoryId, city: 'Москва' });
  listingId = create.body.data.listing.id;
});

describeInfra('orders (integration, mocked stripe)', () => {
  it('creates an escrow order with payment intent', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `ord-${Date.now()}` });
    expect(res.status).toBe(201);
    expect(res.body.data.clientSecret).toBe('pi_3_secret_test');
    expect(res.body.data.order.status).toBe('PENDING');
  });

  it('rejects a second order for the same listing', async () => {
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `ord2-${Date.now()}` });
    const second = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `ord2-${Date.now()}-dup` });
    expect(second.status).toBe(409);
  });
});
