import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';
import { handleYookassaNotification } from '../src/services/paymentService.js';

// Мокаем сеть ЮKassa, а не createEscrowOrder: сервис остаётся настоящим,
// чтобы проверки (идемпотентность, «второй заказ на то же объявление») были честными.
const fake = installYookassaFake({ createStatus: 'pending' });

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
let buyerToken = '';
let categoryId = '';
let listingId = '';
let webhookListingId = '';

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const sellerPhone = `+7${Date.now().toString().slice(-9)}4`;
  await request(app).post('/api/auth/register').send({ name: 'Продавец', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({
    where: { id: seller.id },
    data: { yookassaShopId: 'shop_seller_test', yookassaOnboarded: true },
  });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  const sellerToken = sellerLogin.body.data.accessToken as string;

  const buyerPhone = `+7${Date.now().toString().slice(-9)}5`;
  await request(app).post('/api/auth/register').send({ name: 'Покупатель', phone: buyerPhone, password, confirmPassword: password });
  const buyer = await request(app).post('/api/auth/login').send({ phone: buyerPhone, password });
  buyerToken = buyer.body.data.accessToken;

  const makeListing = async (title: string) => {
    const res = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title, description: 'Описание товара для проверки оплаты', price: 100, categoryId, city: 'Москва' });
    return res.body.data.listing.id as string;
  };
  listingId = await makeListing('Товар для оплаты');
  webhookListingId = await makeListing('Товар для вебхука');
});

describeInfra('orders (integration, mocked yookassa)', () => {
  it('создаёт эскроу-заказ и отдаёт токен виджета ЮKassa', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `ord-${Date.now()}` });
    expect(res.status).toBe(201);
    expect(res.body.data.confirmationToken).toMatch(/^tok_/);
    expect(res.body.data.order.status).toBe('PENDING');
    expect(fake.calls.create).toBe(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.order.id } });
    expect(order.yookassaPaymentId).toBe(fake.lastPaymentId());
  });

  it('вебхук payment.waiting_for_capture переводит PENDING -> PAID', async () => {
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId: webhookListingId, idempotencyKey: `ord-webhook-${Date.now()}` });
    expect(created.status).toBe(201);
    const paymentId = fake.lastPaymentId();
    fake.setPaymentStatus(paymentId, 'waiting_for_capture');

    const res = await handleYookassaNotification(
      Buffer.from(
        JSON.stringify({
          type: 'notification',
          event: 'payment.waiting_for_capture',
          object: { id: paymentId, status: 'waiting_for_capture' },
        })
      )
    );
    expect(res.received).toBe(true);
    const order = await prisma.order.findFirstOrThrow({ where: { yookassaPaymentId: paymentId } });
    expect(order.status).toBe('PAID');
  });

  it('отклоняет второй заказ на то же объявление', async () => {
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
