import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { prisma } from '@marketplace/db';
import type { UserRole } from '@marketplace/db';
import { createApp } from '../src/app.js';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';

const app = createApp();
const password = 'Strong123!';
const unique = Date.now();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

function phone(n: string): string {
  return `+7${unique.toString().slice(-8)}${n}`;
}

async function createUserRow(p: string, role: UserRole = 'USER') {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
  return prisma.user.create({ data: { name: `Каталог ${role}`, phone: p, passwordHash, role } });
}

async function loginToken(p: string): Promise<string> {
  const login = await request(app).post('/api/auth/login').send({ phone: p, password });
  expect(login.status).toBe(200);
  return login.body.data.accessToken as string;
}

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('п.39: ?all=1 (категории и регионы) только для MODERATOR/ADMIN', () => {
  it('аноним: с ?all=1 → 401, без флага → 200', async () => {
    const withFlag = await request(app).get('/api/categories?all=1');
    expect(withFlag.status).toBe(401);

    const without = await request(app).get('/api/categories');
    expect(without.status).toBe(200);
    expect(Array.isArray(without.body.data.categories)).toBe(true);

    const regions = await request(app).get('/api/regions');
    expect(regions.status).toBe(200);
  });

  it('обычный пользователь: с ?all=1 → 403, без флага → 200', async () => {
    const p = phone('391');
    await createUserRow(p, 'USER');
    const token = await loginToken(p);

    const cats = await request(app).get('/api/categories?all=1').set('Authorization', `Bearer ${token}`);
    expect(cats.status).toBe(403);

    const regions = await request(app).get('/api/regions?all=1').set('Authorization', `Bearer ${token}`);
    expect(regions.status).toBe(403);

    const without = await request(app).get('/api/categories').set('Authorization', `Bearer ${token}`);
    expect(without.status).toBe(200);
  });

  it('модератор: с ?all=1 → 200 и для категорий, и для регионов', async () => {
    const p = phone('392');
    await createUserRow(p, 'MODERATOR');
    const token = await loginToken(p);

    const cats = await request(app).get('/api/categories?all=1').set('Authorization', `Bearer ${token}`);
    expect(cats.status).toBe(200);
    expect(Array.isArray(cats.body.data.categories)).toBe(true);

    const regions = await request(app).get('/api/regions?all=1').set('Authorization', `Bearer ${token}`);
    expect(regions.status).toBe(200);
    expect(Array.isArray(regions.body.data.regions)).toBe(true);
  });

  it('админ: с ?all=1 → 200', async () => {
    const p = phone('393');
    await createUserRow(p, 'ADMIN');
    const token = await loginToken(p);

    const cats = await request(app).get('/api/categories?all=1').set('Authorization', `Bearer ${token}`);
    expect(cats.status).toBe(200);
  });
});
