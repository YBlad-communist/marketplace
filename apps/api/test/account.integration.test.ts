import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';
import { installYookassaFake } from './yookassa-fake.js';

// Создание заказа идёт через paymentService (сеть ЮKassa) — мокаем, как в reviews-тесте.
installYookassaFake({ createStatus: 'waiting_for_capture' });

const app = createApp();
const password = 'Strong123!';
const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

let categoryId = '';

async function registerAndLogin(name: string, phone: string) {
  await request(app).post('/api/auth/register').send({ name, phone, password, confirmPassword: password });
  const login = await request(app).post('/api/auth/login').send({ phone, password });
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  return { token: login.body.data.accessToken as string, userId: user.id };
}

beforeAll(async () => {
  await connectRedis();
  const cat = await prisma.category.findFirst({ where: { slug: 'services' } });
  categoryId = cat?.id ?? '';
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('account deletion (integration)', () => {
  it('rejects deletion with wrong password -> 401', async () => {
    const { token } = await registerAndLogin('Удаляемый', `+7${Date.now().toString().slice(-9)}3`);
    const res = await request(app)
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'Wrong123!' });
    expect(res.status).toBe(401);
  });

  it('blocks deletion with active order -> 409', async () => {
    const seller = await registerAndLogin('Продавец-удаление', `+7${Date.now().toString().slice(-9)}4`);
    const buyer = await registerAndLogin('Покупатель-удаление', `+7${Date.now().toString().slice(-9)}5`);
    await prisma.user.update({
      where: { id: seller.userId },
      data: { yookassaShopId: 'shop_del', yookassaOnboarded: true },
    });
    const created = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${seller.token}`)
      .send({ title: 'Товар для блокировки удаления', description: 'Описание товара для блокировки удаления аккаунта', price: 100, categoryId, city: 'Казань' });
    expect(created.status).toBe(201);
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ listingId: created.body.data.listing.id, idempotencyKey: `del-${Date.now()}` });
    expect(order.status).toBe(201);

    const res = await request(app)
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ password });
    expect(res.status).toBe(409);
  });

  it('fully deletes account with correct password', async () => {
    const { token, userId } = await registerAndLogin('Стираемый', `+7${Date.now().toString().slice(-9)}6`);
    const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);

    const res = await request(app)
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password });
    expect(res.status).toBe(200);

    // Пользователя больше нет: повторный вход невозможен, /me отдаёт 401.
    const relogin = await request(app).post('/api/auth/login').send({ phone: me.body.data.user.phone, password });
    expect(relogin.status).toBe(401);
    const gone = await prisma.user.findUnique({ where: { id: userId } });
    expect(gone).toBeNull();
  });
});
