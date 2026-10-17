import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis, getRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable, markPhoneVerified } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';
import { handleYookassaNotification, ensureSellerPayout } from '../src/services/paymentService.js';

const fake = installYookassaFake({ createStatus: 'waiting_for_capture' });

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

let sellerToken = '';
let buyerToken = '';
let buyer2Token = '';
let categoryId = '';
let listingCounter = 0;

async function makeListing(title: string): Promise<string> {
  const res = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title, description: 'Описание товара для блока 2', price: 100, categoryId, city: 'Москва' });
  expect(res.status).toBe(201);
  return res.body.data.listing.id as string;
}

async function registerBuyer(name: string, suffix: string): Promise<{ token: string; phone: string; id: string }> {
  const phone = `+7${unique.toString().slice(-8)}${suffix}`;
  await request(app).post('/api/auth/register').send({ name, phone, password, confirmPassword: password });
  await markPhoneVerified(phone);
  const login = await request(app).post('/api/auth/login').send({ phone, password });
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  return { token: login.body.data.accessToken as string, phone, id: user.id };
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const sellerPhone = `+7${unique.toString().slice(-9)}1`;
  await request(app).post('/api/auth/register').send({ name: 'Продавец-б2', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({ where: { id: seller.id }, data: { yookassaShopId: '12345', yookassaOnboarded: true, payoutAccountId: '12345', payoutOnboarded: true } });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  sellerToken = sellerLogin.body.data.accessToken as string;

  const buyer = await registerBuyer('Покупатель-б2-1', '2');
  buyerToken = buyer.token;
  const buyer2 = await registerBuyer('Покупатель-б2-2', '3');
  buyer2Token = buyer2.token;
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('блок 2: деньги и эскроу', () => {
  it('п.8: заказ без подтверждённого телефона -> 403', async () => {
    const phone = `+7${unique.toString().slice(-8)}9`;
    await request(app).post('/api/auth/register').send({ name: 'Без-телефона', phone, password, confirmPassword: password });
    const login = await request(app).post('/api/auth/login').send({ phone, password });
    const token = login.body.data.accessToken as string;
    const listingId = await makeListing(`Товар без телефона ${++listingCounter}`);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ listingId, idempotencyKey: `nophone-${unique}-${listingCounter}` });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/телефон/i);
  });

  it('п.9: чужой idempotency-ключ -> 409, чужой confirmation_token не возвращается', async () => {
    const key = `idem-${unique}-shared`;
    const listingA = await makeListing(`Товар идем-А ${++listingCounter}`);
    const first = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId: listingA, idempotencyKey: key });
    expect(first.status).toBe(201);

    // Второй покупатель шлёт тот же ключ: не должен получить токен первого.
    const listingB = await makeListing(`Товар идем-Б ${++listingCounter}`);
    const second = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyer2Token}`)
      .send({ listingId: listingB, idempotencyKey: key });
    expect(second.status).toBe(409);
    expect(second.body.data?.confirmationToken).toBeUndefined();
  });

  it('п.9: свой ключ с тем же покупателем возвращает существующий заказ (идемпотентно)', async () => {
    const key = `idem-${unique}-samebuyer`;
    const listingId = await makeListing(`Товар идем-повтор ${++listingCounter}`);
    const first = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: key });
    expect(first.status).toBe(201);
    const again = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: key });
    expect(again.status).toBe(201);
    expect(again.body.data.order.id).toBe(first.body.data.order.id);
  });

  it('п.10: ошибка провайдера при вебхуке -> ключ дедупа удаляется, retry обрабатывается', async () => {
    // Вебхук на неизвестный платёж: fake отдаёт 404 -> провайдер кидает ->
    // handleYookassaNotification должен пробросить ошибку (5xx для ЮKassa),
    // а ключ дедупа — удалиться, чтобы retry не получил 'duplicate'.
    const body = Buffer.from(
      JSON.stringify({
        type: 'notification',
        event: 'payment.waiting_for_capture',
        object: { id: 'yoo_pay_missing_123', status: 'waiting_for_capture' },
      })
    );
    let threw = false;
    try {
      await handleYookassaNotification(body);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Ключ дедупа должен отсутствовать: повторная доставка снова идёт в обработку.
    const redis = getRedis();
    const keys = await redis.keys('payment:webhook:*yoo_pay_missing_123*');
    expect(keys).toHaveLength(0);
  });

  it('п.10: успешный вебхук ставит ключ дедупа, повтор -> duplicate', async () => {
    const listingId = await makeListing(`Товар вебхук-дедуп ${++listingCounter}`);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `dedup-${unique}-${listingCounter}` });
    expect(created.status).toBe(201);
    const paymentId = fake.lastPaymentId();

    const body = Buffer.from(
      JSON.stringify({
        type: 'notification',
        event: 'payment.waiting_for_capture',
        object: { id: paymentId, status: 'waiting_for_capture' },
      })
    );
    const first = await handleYookassaNotification(body);
    expect(first.handled).not.toBe('duplicate');
    const second = await handleYookassaNotification(body);
    expect(second.handled).toBe('duplicate');
  });

  it('п.11: некорректный формат реквизита выплат -> 400', async () => {
    await expect(ensureSellerPayout((await prisma.user.findFirst({ where: { phone: { contains: unique.toString().slice(-9) } } }))?.id ?? '', 'bad ref!')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('п.11: смена реквизита при активном заказе -> 409', async () => {
    const listingId = await makeListing(`Товар смена-рефа ${++listingCounter}`);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `refchange-${unique}-${listingCounter}` });
    expect(created.status).toBe(201);

    const seller = await prisma.user.findFirst({ where: { yookassaShopId: '12345' } });
    await expect(ensureSellerPayout(seller!.id, '99999')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('п.11: смена реквизита без активных заказов проходит', async () => {
    const seller = await prisma.user.findFirst({ where: { yookassaShopId: '12345' } });
    // Сначала снимаем активный заказ из предыдущего теста.
    await prisma.order.updateMany({
      where: { listing: { sellerId: seller!.id }, status: { in: ['PENDING', 'PAID'] } },
      data: { status: 'REFUNDED' },
    });
    await prisma.listing.updateMany({
      where: { sellerId: seller!.id, status: 'RESERVED' },
      data: { status: 'ACTIVE' },
    });
    const result = await ensureSellerPayout(seller!.id, '77777');
    expect(result.accountRef).toBe('77777');
  });
});
