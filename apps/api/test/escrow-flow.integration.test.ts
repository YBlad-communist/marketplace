import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@marketplace/db';
import { connectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';
import { handleYookassaNotification } from '../src/services/paymentService.js';

// Мокаем сеть ЮKassa: create возвращает waiting_for_capture, дальше платёж
// добивается вебхуком — сервис остаётся настоящим.
const fake = installYookassaFake({ createStatus: 'waiting_for_capture' });

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

let sellerToken = '';
let buyerToken = '';
let adminToken = '';
let categoryId = '';

async function makeListing(title: string): Promise<string> {
  const res = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title, description: 'Описание товара для теста эскроу-флоу', price: 100, categoryId, city: 'Москва' });
  expect(res.status).toBe(201);
  return res.body.data.listing.id as string;
}

async function makeOrder(listingId: string, key: string): Promise<string> {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ listingId, idempotencyKey: `flow-${unique}-${key}` });
  expect(res.status).toBe(201);
  return res.body.data.order.id as string;
}

async function payOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  await handleYookassaNotification(
    Buffer.from(
      JSON.stringify({
        type: 'notification',
        event: 'payment.waiting_for_capture',
        object: { id: order.yookassaPaymentId, status: 'waiting_for_capture' },
      })
    )
  );
  const paid = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(paid.status).toBe('PAID');
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const sellerPhone = `+7${unique.toString().slice(-9)}1`;
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Продавец-флоу', phone: sellerPhone, password, confirmPassword: password });
  const seller = await prisma.user.findUniqueOrThrow({ where: { phone: sellerPhone } });
  await prisma.user.update({
    where: { id: seller.id },
    data: { yookassaShopId: 'shop_flow', yookassaOnboarded: true },
  });
  const sellerLogin = await request(app).post('/api/auth/login').send({ phone: sellerPhone, password });
  sellerToken = sellerLogin.body.data.accessToken as string;

  const buyerPhone = `+7${unique.toString().slice(-9)}2`;
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Покупатель-флоу', phone: buyerPhone, password, confirmPassword: password });
  const buyerLogin = await request(app).post('/api/auth/login').send({ phone: buyerPhone, password });
  buyerToken = buyerLogin.body.data.accessToken as string;

  const adminPhone = `+7${unique.toString().slice(-9)}3`;
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Админ-флоу', phone: adminPhone, password, confirmPassword: password });
  const adminUser = await prisma.user.findUniqueOrThrow({ where: { phone: adminPhone } });
  await prisma.user.update({ where: { id: adminUser.id }, data: { role: 'ADMIN' } });
  const adminLogin = await request(app).post('/api/auth/login').send({ phone: adminPhone, password });
  adminToken = adminLogin.body.data.accessToken as string;
});

describeInfra('escrow flow (integration, mocked yookassa)', () => {
  it('пока активен — 409; после возврата — повторная покупка 201', async () => {
    const listingId = await makeListing('Повторная покупка');
    const orderId = await makeOrder(listingId, 'rebuy-first');
    await payOrder(orderId);

    const blocked = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `flow-${unique}-rebuy-dup` });
    expect(blocked.status).toBe(409);

    const refund = await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(refund.status).toBe(200);
    const refunded = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(refunded.status).toBe('REFUNDED');
    const freed = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(freed.status).toBe('ACTIVE');

    const again = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listingId, idempotencyKey: `flow-${unique}-rebuy-second` });
    expect(again.status).toBe(201);
    // Заблокированный дубль не создавал платёж, повторная покупка — создала.
    expect(fake.calls.create).toBeGreaterThanOrEqual(2);
  });

  it('ship: только продавец, PAID -> SHIPPED; покупательский refund — 409', async () => {
    const listingId = await makeListing('Отправка товара');
    const orderId = await makeOrder(listingId, 'ship');
    await payOrder(orderId);

    const buyerShip = await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ comment: 'не я продавец' });
    expect(buyerShip.status).toBe(403);

    const ship = await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ comment: 'Передал лично', trackingNumber: 'TRACK123' });
    expect(ship.status).toBe(200);
    const shipped = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.shippedAt).not.toBeNull();

    const refund = await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(refund.status).toBe(409);

    const again = await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({});
    expect(again.status).toBe(409);
  });

  it('покупатель подтверждает получение после отправки: SHIPPED -> RELEASED', async () => {
    const listingId = await makeListing('Подтверждение получения');
    const orderId = await makeOrder(listingId, 'release-after-ship');
    await payOrder(orderId);
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ comment: 'Отправил' });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status
    ).toBe('SHIPPED');

    const release = await request(app)
      .post(`/api/orders/${orderId}/release`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(release.status).toBe(200);
    const released = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(released.status).toBe('RELEASED');
  });

  it('спор: открытие покупателем только после отправки; повтор — 409', async () => {
    const listingId = await makeListing('Спор до отправки');
    const orderId = await makeOrder(listingId, 'dispute-early');
    await payOrder(orderId);

    const early = await request(app)
      .post(`/api/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reason: 'Товар не пришёл' });
    expect(early.status).toBe(409);

    const sellerDispute = await request(app)
      .post(`/api/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ reason: 'Товар не пришёл' });
    expect(sellerDispute.status).toBe(403);

    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ comment: 'Отправил' });

    const opened = await request(app)
      .post(`/api/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reason: 'Получил не то', comment: 'Другой товар', photos: ['photos/dispute-1.jpg'] });
    expect(opened.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('DISPUTED');

    const twice = await request(app)
      .post(`/api/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reason: 'Ещё раз' });
    expect(twice.status).toBe(409);

    const noComment = await request(app)
      .post(`/api/admin/disputes/${orderId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'SELLER' });
    expect(noComment.status).toBe(400);

    const asBuyer = await request(app)
      .post(`/api/admin/disputes/${orderId}/resolve`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ decision: 'SELLER', comment: 'покупатель не решает' });
    expect(asBuyer.status).toBe(403);

    const list = await request(app)
      .get('/api/admin/disputes')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const openDisputes = list.body.data.disputes as {
      id: string;
      photos: string[];
      order: { id: string; amount: number };
    }[];
    const mine = openDisputes.find((d) => d.order.id === orderId);
    expect(mine).toBeTruthy();
    expect(mine!.photos[0]).toContain('photos/dispute-1.jpg');
    expect(mine!.order.amount).toBe(100);

    const toSeller = await request(app)
      .post(`/api/admin/disputes/${orderId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'SELLER', comment: 'Товар передан, спор в пользу продавца' });
    expect(toSeller.status).toBe(200);
    const resolved = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { dispute: true },
    });
    expect(resolved.status).toBe('RELEASED');
    expect(resolved.dispute?.status).toBe('RESOLVED');
    expect(resolved.dispute?.resolution).toBe('SELLER');
  });

  it('решение спора в пользу покупателя возвращает деньги', async () => {
    const listingId = await makeListing('Спор в пользу покупателя');
    const orderId = await makeOrder(listingId, 'dispute-buyer');
    await payOrder(orderId);
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ comment: 'Отправил' });
    await request(app)
      .post(`/api/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reason: 'Товар бракованный' });

    const resolve = await request(app)
      .post(`/api/admin/disputes/${orderId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'BUYER', comment: 'Подтверждён брак, возврат покупателю' });
    expect(resolve.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { dispute: true },
    });
    expect(order.status).toBe('REFUNDED');
    expect(order.dispute?.resolution).toBe('BUYER');
  });

  it('гонка release vs dispute: побеждает ровно одна сторона', async () => {
    const listingId = await makeListing('Гонка release и спора');
    const orderId = await makeOrder(listingId, 'race');
    await payOrder(orderId);
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ comment: 'Отправил' });

    const [release, dispute] = await Promise.all([
      request(app).post(`/api/orders/${orderId}/release`).set('Authorization', `Bearer ${buyerToken}`),
      request(app)
        .post(`/api/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ reason: 'Гоночный спор' }),
    ]);

    const winners = [release.status, dispute.status].filter((s) => s >= 200 && s < 300);
    expect(winners).toHaveLength(1);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { dispute: true },
    });
    if (order.status === 'DISPUTED') {
      expect(order.dispute).toBeTruthy();
      expect(release.status).toBe(409);
    } else {
      expect(['RELEASING', 'RELEASED']).toContain(order.status);
      expect(order.dispute).toBeNull();
      expect(dispute.status).toBe(409);
    }
  });

  it('guard: с активным SHIPPED-заказом объявление нельзя редактировать и удалять', async () => {
    const listingId = await makeListing('Залоченное шипментом');
    const orderId = await makeOrder(listingId, 'guard');
    await payOrder(orderId);
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ comment: 'Отправил' });

    const edit = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price: 90 });
    expect(edit.status).toBe(409);

    const del = await request(app)
      .delete(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(del.status).toBe(409);

    await request(app).post(`/api/orders/${orderId}/release`).set('Authorization', `Bearer ${buyerToken}`);
    const afterRelease = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price: 90 });
    expect(afterRelease.status).toBe(200);
  });

  it('guard: удаление аккаунта админом блокируется активным SHIPPED-заказом', async () => {
    const victimPhone = `+7${unique.toString().slice(-9)}4`;
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Victim-шипмент', phone: victimPhone, password, confirmPassword: password });
    const victim = await prisma.user.findUniqueOrThrow({ where: { phone: victimPhone } });
    await prisma.user.update({
      where: { id: victim.id },
      data: { yookassaShopId: 'shop_victim', yookassaOnboarded: true },
    });
    const victimLogin = await request(app).post('/api/auth/login').send({ phone: victimPhone, password });
    const victimToken = victimLogin.body.data.accessToken as string;

    const listingRes = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${victimToken}`)
      .send({
        title: 'Аккаунт под удаление',
        description: 'Описание товара для теста удаления аккаунта',
        price: 100,
        categoryId,
        city: 'Москва',
      });
    expect(listingRes.status).toBe(201);
    const listingId = listingRes.body.data.listing.id as string;
    const orderId = await makeOrder(listingId, 'victim');
    await payOrder(orderId);
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${victimToken}`)
      .send({ comment: 'Отправил' });

    const del = await request(app)
      .delete(`/api/admin/users/${victim.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(409);

    const stillThere = await prisma.user.findUnique({ where: { id: victim.id } });
    expect(stillThere).toBeTruthy();
  });
});
