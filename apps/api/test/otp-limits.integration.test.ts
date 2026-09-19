import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const password = 'Strong123!';
const unique = Date.now();

async function registerAndLogin(prefix: string, phoneSuffix: string) {
  const phone = `+7${unique.toString().slice(-9)}${phoneSuffix}`;
  await request(app)
    .post('/api/auth/register')
    .send({ name: prefix, phone, password, confirmPassword: password });
  const login = await request(app).post('/api/auth/login').send({ phone, password });
  return { phone, token: login.body.data.accessToken as string };
}

async function requestOtp(token: string) {
  return request(app)
    .post('/api/auth/verification/request')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'phone' });
}

let userA = { phone: '', token: '' };
let userB = { phone: '', token: '' };

beforeAll(async () => {
  await connectRedis();
  userA = await registerAndLogin('ОТП-пользователь', '6');
  userB = await registerAndLogin('ОТП-пользователь-2', '7');
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('OTP: лимиты отправки кода закрывают SMS-бомбинг и бюджеты', () => {
  it('второй запрос кода за 60 сек на тот же номер -> 429 + Retry-After', async () => {
    const first = await requestOtp(userA.token);
    expect(first.status).toBe(200);

    const second = await requestOtp(userA.token);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(second.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(61);
  });

  it('лимит изолирован по цели: чужой номер не блокируется моим лимитом', async () => {
    const res = await requestOtp(userB.token);
    expect(res.status).toBe(200);
  });
});