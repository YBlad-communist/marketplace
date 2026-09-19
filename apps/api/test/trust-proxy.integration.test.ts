import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config.js';
import { isInfraAvailable } from './helpers.js';
import { ipKeyFor, keyFor } from '../src/middleware/rateLimit.js';

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const unique = Date.now();
const password = 'Strong123!';
const phone = `+7${unique.toString().slice(-9)}1`;

async function loginWithXff(xff: string) {
  return request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', xff)
    .send({ phone, password });
}

async function lastNameStoredIp(): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) return null;
  const family = await prisma.refreshTokenFamily.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  return family?.ip ?? null;
}

beforeAll(async () => {
  await connectRedis();
  await request(app)
    .post('/api/auth/register')
    .send({ name: 'Прокси-тест', phone, password, confirmPassword: password });
});

afterAll(async () => {
  await disconnectRedis();
});

describe('trust proxy (unit): настройка и ключи rate limit', () => {
  it('trust proxy установлен числом хопов, а не true', () => {
    // С true Express брал бы последний адрес из любого количества хопов;
    // с числом N он отсчитывает ровно N адресов от нас. Подмена левых частей
    // XFF = увеличение числа хопов, и при числовом значении атакующему не
    // удаётся «сдвинуть» свой реальный IP.
    expect(typeof env.TRUST_PROXY_HOPS).toBe('number');
    expect(app.get('trust proxy')).toBe(env.TRUST_PROXY_HOPS);
  });

  it('ipKeyFor не привязывается к userId (строго IP)', () => {
    expect(ipKeyFor({ ip: '9.9.9.9', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request))
      .toBe(ipKeyFor({ ip: '9.9.9.9', socket: { remoteAddress: '127.0.0.1' }, userId: 'u1' } as unknown as Request));
  });

  it('keyFor с userId и без — разные ведра (без обхода по IP)', () => {
    expect(keyFor({ ip: '9.9.9.9', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request))
      .not.toBe(keyFor({ ip: '9.9.9.9', socket: { remoteAddress: '127.0.0.1' }, userId: 'u1' } as unknown as Request));
  });

  it('разные реальные IP дают разные ключи (личность не коллизирует)', () => {
    expect(ipKeyFor({ ip: '1.1.1.1', socket: { remoteAddress: '' } } as unknown as Request))
      .not.toBe(ipKeyFor({ ip: '2.2.2.2', socket: { remoteAddress: '' } } as unknown as Request));
  });
});

describeInfra('trust proxy (integration): подделка X-Forwarded-For не влияет на rate-limit личность', () => {
  it('req.ip = правый (ближайший к серверу) адрес XFF при trust proxy = 1', async () => {
    const res = await loginWithXff('203.0.113.7, 198.51.100.23');
    expect(res.status).toBe(200);
    // Левый «203.0.113.7» подделан клиентом — сервер его игнорирует.
    expect(await lastNameStoredIp()).toBe('198.51.100.23');
  });

  it('добавление поддельных левых хопов не меняет личность (IP остаётся прежним)', async () => {
    await loginWithXff('101.101.101.101, 203.0.113.7, 198.51.100.23');
    expect(await lastNameStoredIp()).toBe('198.51.100.23');
  });

  it('смена правого (настоящего) адреса меняет личность честно', async () => {
    await loginWithXff('203.0.113.7, 192.0.2.55');
    expect(await lastNameStoredIp()).toBe('192.0.2.55');
  });
});