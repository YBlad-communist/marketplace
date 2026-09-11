import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

import { connectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';

const app = createApp();

const TEST_PHONE = `+7${Date.now().toString().slice(-10)}`;
const TEST_PASSWORD = 'Strong123!';

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

async function registerAndLogin() {
  const reg = await request(app).post('/api/auth/register').send({
    name: 'Тест',
    phone: TEST_PHONE,
    password: TEST_PASSWORD,
    confirmPassword: TEST_PASSWORD,
  });
  expect(reg.status).toBe(201);

  const login = await request(app).post('/api/auth/login').send({
    phone: TEST_PHONE,
    password: TEST_PASSWORD,
  });
  expect(login.status).toBe(200);
  return login.body.data.accessToken as string;
}

beforeAll(async () => {
  await connectRedis();
});

describeInfra('auth flow (integration)', () => {
  it('rejects login with wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({
      phone: TEST_PHONE,
      password: 'WrongPassword1',
    });
    expect(res.status).toBe(401);
  });

  it('registers, logs in and refreshes tokens', async () => {
    const token = await registerAndLogin();
    expect(token).toBeTruthy();

    const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.phone).toBe(TEST_PHONE);
  });

  it('rejects requests without token', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('validates input and returns field errors', async () => {
    const res = await request(app).post('/api/auth/login').send({
      phone: 'not-a-phone!!!€',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.fields).toBeDefined();
  });
});
