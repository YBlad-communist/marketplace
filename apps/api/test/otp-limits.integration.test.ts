import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { prisma } from '@marketplace/db';
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

/**
 * Пользователь, созданный мимо эндпоинта register: SMS (и ведро OTP-лимита)
 * при этом не расходуется — нужен для проверки изоляции лимитов по цели.
 */
async function loginDirect(prefix: string, phoneSuffix: string) {
  const phone = `+7${unique.toString().slice(-9)}${phoneSuffix}`;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
  await prisma.user.create({ data: { name: prefix, phone, passwordHash } });
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
let userC = { phone: '', token: '' };

beforeAll(async () => {
  await connectRedis();
  userA = await registerAndLogin('ОТП-пользователь', '6');
  userC = await loginDirect('ОТП-пользователь-C', '8');
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('OTP: лимиты отправки кода закрывают SMS-бомбинг и бюджеты', () => {
  it('запрос кода сразу после регистрации -> 429 + Retry-After (SMS уже ушёл при register)', async () => {
    // П.25: register вызывает assertOtpSendAllowed и отправляет SMS —
    // повторный запрос кода в течение 60 секунд блокируется.
    const res = await requestOtp(userA.token);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(61);
  });

  it('лимит изолирован по цели: чужой номер с чистым ведром получает код', async () => {
    const res = await requestOtp(userC.token);
    expect(res.status).toBe(200);
  });
});
