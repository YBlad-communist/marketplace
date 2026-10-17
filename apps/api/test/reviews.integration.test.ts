import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable, markPhoneVerified } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';

// Мокаем сеть ЮKassa: реальные createEscrowOrder/releaseOrder/refundOrder,
// поэтому проверки статусных переходов заказа честные.
installYookassaFake({ createStatus: 'waiting_for_capture' });

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
  // В тесте эмулируем вебхук payment.waiting_for_capture: PENDING -> PAID.
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
    data: { yookassaShopId: 'shop_rev', yookassaOnboarded: true },
  });

  const buyerPhone = `+7${Date.now().toString().slice(-9)}2`;
  buyerToken = await registerAndLogin('Покупатель отзывов', buyerPhone);
  await markPhoneVerified(buyerPhone);
  buyerId = (await prisma.user.findUniqueOrThrow({ where: { phone: buyerPhone } })).id;
  // Аудит п.17: свободный отзыв без сделки доступен с 7-го дня аккаунта —
  // «состариваем» основного покупателя, чтобы существующий тест профильного
  // отзыва проходил по новому правилу.
  await prisma.user.update({
    where: { id: buyerId },
    data: { createdAt: new Date(Date.now() - 8 * 86_400_000) },
  });

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
    // Аудит п.5: покупатель сам не возвращает оплаченный заказ — статус
    // REFUNDED выставляем напрямую (сценарий теста — проверка guard'а отзыва).
    await prisma.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
    await prisma.listing.update({ where: { id: refundListingId }, data: { status: 'ACTIVE' } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('REFUNDED');

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: sellerId, orderId, rating: 3, text: 'Не тот товар' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('анти-накрутка: второй отзыв той же пары за окно -> 409', async () => {    // Сначала по этой паре уже есть один успешный отзыв (первый тест):
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

  it('свободный отзыв с профиля (без orderId) -> 201, повторный -> 409', async () => {
    const first = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: sellerId, rating: 5, text: 'Хороший продавец' });
    expect(first.status).toBe(201);
    expect(first.body.data.review.orderId).toBeNull();

    const dup = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: sellerId, rating: 4, text: 'Второй отзыв без сделки' });
    expect(dup.status).toBe(409);
  });

  it('отклоняет отзыв самому себе без сделки -> 400', async () => {
    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ revieweeId: buyerId, rating: 5, text: 'Сам себе' });
    expect(res.status).toBe(400);
  });

  it('п.17: свободный отзыв без подтверждённого телефона -> 403', async () => {
    const phone = `+7${Date.now().toString().slice(-9)}7`;
    const token = await registerAndLogin('Без-телефона-отзыв', phone);
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    await prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ revieweeId: sellerId, rating: 5, text: 'Отзыв без телефона' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/телефон/i);
  });

  it('п.17: свободный отзыв с аккаунтом младше 7 дней -> 403', async () => {
    const phone = `+7${Date.now().toString().slice(-9)}8`;
    const token = await registerAndLogin('Свежий-аккаунт-отзыв', phone);
    await markPhoneVerified(phone);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ revieweeId: sellerId, rating: 5, text: 'Отзыв со свежего аккаунта' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/7/);
  });

  it('п.17: гонка двух параллельных свободных отзывов одного автора — ровно один 201 (уникальный индекс)', async () => {
    const phoneA = `+7${Date.now().toString().slice(-9)}3`;
    const tokenA = await registerAndLogin('Гонка-отзыв-А', phoneA);
    await markPhoneVerified(phoneA);
    await prisma.user.updateMany({
      where: { phone: phoneA },
      data: { createdAt: new Date(Date.now() - 30 * 86_400_000) },
    });

    const payload = { revieweeId: sellerId, rating: 4, text: 'Параллельный свободный отзыв' };
    const [a, b] = await Promise.all([
      request(app).post('/api/reviews').set('Authorization', `Bearer ${tokenA}`).send(payload),
      request(app).post('/api/reviews').set('Authorization', `Bearer ${tokenA}`).send(payload),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
  });
});