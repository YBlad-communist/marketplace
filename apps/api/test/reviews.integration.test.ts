import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';

// Мокаем Stripe-SDK: реальный createEscrowOrder/releaseOrder/refundOrder,
// поэтому проверки статусных переходов заказа честные.
vi.mock('stripe', () => {
  class FakeStripe {
    paymentIntents = {
      create: vi.fn(async () => ({ id: 'pi_rev_mock', client_secret: 'pi_rev_secret' })),
      retrieve: vi.fn(async () => ({ id: 'pi_rev_mock', status: 'requires_capture' })),
      capture: vi.fn(async () => ({ status: 'succeeded' })),
      cancel: vi.fn(async () => ({})),
    };
    transfers = {
      create: vi.fn(async () => ({ id: 'tr_rev_mock' })),
    };
    refunds = {
      create: vi.fn(async () => ({ id: 're_rev_mock' })),
    };
  }
  return { __esModule: true, default: FakeStripe };
});

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
let sellerToken = '';
let sellerId = '';
let buyerToken = '';
let buyerId = '';
let categoryId = '';
let normalListingId = '';
let smallListingId = '';
let refundListingId = '';
let pairListingId = '';

async function registerAndLogin(name: string, phone: string) {
  await request(app).post('/api/auth/register').send({ name, phone, password, confirmPassword: password });
  const login = await request(app).post('/api/auth/login').send({ phone, password });
  return login.body.data.accessToken as string;
}

async function createOrderAndPay(listingId: string, keySuffix: string): Promise<string> {
  const created = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ listingId, idempotencyKey: `rev-${Date.now()}-${keySuffix}` });
  expect(created.status).toBe(201);
  const orderId = created.body.data.order.id as string;
  // В тесте эмулируем вебхук payment_intent.amount_capturable_updated: PENDING -> PAID.
  await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
  return orderId;
}

async function releaseOrder(orderId: string) {
  const res = await request(app)
    .post(`/api/orders/${orderId}/release`)
    .set('Authorization', `Bearer ${buyerToken}`);
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const sellerPhone = `+7${Date.now().toString().slice(-9)}1`;
  sellerToken = await registerAndLogin('Продавец отзывов', sellerPhone);
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  sellerId = seller.id;
  await prisma.user.update({
    where: { id: seller.id },
    data: { stripeAccountId: 'acct_rev', stripeOnboarded: true },
  });

  const buyerPhone = `+7${Date.now().toString().slice(-9)}2`;
  buyerToken = await registerAndLogin('Покупатель отзывов', buyerPhone);
  buyerId = (await prisma.user.findUniqueOrThrow({ where: { phone: buyerPhone } })).id;

  const createListing = async (title: string, price: number) => {
    const res = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title, description: 'Описание товара для теста отзыва', price, categoryId, city: 'Москва' });
    expect(res.status).toBe(201);
    return res.body.data.listing.id as string;
  };

  normalListingId = await createListing('Товар для честного отзыва', 100);
  smallListingId = await createListing('Копеечный товар', 0.5);
  refundListingId = await createListing('Товар с возвратом', 100);
  pairListingId = await createListing('Товар для пары-лимита', 100);
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('reviews (integration): целостность рейтинга', () => {
  it('позволяет отзыв только по завершённой (RELEASED) сделке с нормальной суммой', async () => {
    const orderId = await createOrderAndPay(normalListingId, 'ok');
    await releaseOrder(orderId);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: sellerId, orderId, rating: 5, text: 'Отличный товар' });

    expect(res.status).toBe(201);
    expect(res.body.data.review.rating).toBe(5);
    const seller = await prisma.user.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.ratingCount).toBeGreaterThanOrEqual(1);
  });

  it('отклоняет отзыв по сделке ниже минимальной суммы', async () => {
    const orderId = await createOrderAndPay(smallListingId, 'small');
    await releaseOrder(orderId);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: sellerId, orderId, rating: 5, text: 'Мелкая сделка' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('отклоняет отзыв по возвращённой (REFUNDED) сделке', async () => {
    const orderId = await createOrderAndPay(refundListingId, 'refund');
    const refund = await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(refund.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('REFUNDED');

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: sellerId, orderId, rating: 3, text: 'Не тот товар' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('анти-накрутка: второй отзыв той же пары за окно -> 409', async () => {
    // Сначала по этой паре уже есть один успешный отзыв (первый тест):
    // REVIEW_PAIR_LIMIT=1, поэтому новая сделка той же пары отклоняется.
    const orderId = await createOrderAndPay(pairListingId, 'pair');
    await releaseOrder(orderId);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: sellerId, orderId, rating: 4, text: 'Ещё одна сделка пары' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const pairReviews = await prisma.review.count({
      where: { authorId: buyerId, revieweeId: sellerId },
    });
    expect(pairReviews).toBeGreaterThanOrEqual(1);
  });
});