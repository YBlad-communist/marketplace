import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { createApp } from '../src/app.js';
import { isInfraAvailable } from './helpers.js';

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const phone = `+7${Date.now().toString().slice(-10)}`;
const password = 'Strong123!';

let accessToken = '';
let cookieB = '';

function cookieHeader(raw: string[] | undefined): string {
  return (raw ?? []).map((c) => c.split(';')[0]).join('; ');
}

beforeAll(async () => {
  await connectRedis();
  await request(app).post('/api/auth/register').send({ name: 'Сессии', phone, password, confirmPassword: password });

  await request(app).post('/api/auth/login').send({ phone, password }).set('User-Agent', 'Device-A');

  const loginB = await request(app)
    .post('/api/auth/login')
    .send({ phone, password })
    .set('User-Agent', 'Device-B');
  expect(loginB.status).toBe(200);
  accessToken = loginB.body.data.accessToken as string;
  cookieB = cookieHeader(loginB.headers['set-cookie'] as unknown as string[] | undefined);
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('sessions (integration): экран активных сессий', () => {
  it('список сессий: два устройства, текущая отмечена по refresh-cookie', async () => {
    const res = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieB);

    expect(res.status).toBe(200);
    const items = res.body.data.items as Array<{
      familyId: string;
      userAgent: string | null;
      current: boolean;
    }>;
    expect(items.length).toBe(2);
    const current = items.filter((s) => s.current);
    const others = items.filter((s) => !s.current);
    expect(current).toHaveLength(1);
    // Текущая сессия — Device-B (последний логин, его cookie мы передали).
    expect(current[0].userAgent).toBe('Device-B');
    expect(others).toHaveLength(1);
    expect(others[0].userAgent).toBe('Device-A');
  });

  it('нельзя отозвать текущую сессию', async () => {
    const list = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieB);
    const current = (list.body.data.items as Array<{ familyId: string; current: boolean }>).find((s) => s.current)!;

    const res = await request(app)
      .delete(`/api/auth/sessions/${current.familyId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieB);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('отзыв чужой сессии делает её неактивной', async () => {
    const list = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieB);
    const items = list.body.data.items as Array<{ familyId: string; current: boolean }>;
    const other = items.find((s) => !s.current)!;
    const current = items.find((s) => s.current)!;

    const del = await request(app)
      .delete(`/api/auth/sessions/${other.familyId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieB);
    expect(del.status).toBe(200);

    const after = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieB);
    const rest = after.body.data.items as Array<{ familyId: string; current: boolean }>;
    expect(rest).toHaveLength(1);
    expect(rest[0].familyId).toBe(current.familyId);
    expect(rest[0].current).toBe(true);
  });

  it('несуществующая сессия — 404', async () => {
    const res = await request(app)
      .delete('/api/auth/sessions/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieB);
    expect(res.status).toBe(404);
  });

  it('без авторизации список сессий недоступен', async () => {
    const res = await request(app).get('/api/auth/sessions');
    expect(res.status).toBe(401);
  });

  it('конкурентный refresh одним токеном (две вкладки) не убивает семью', async () => {
    const refresh = () =>
      request(app).post('/api/auth/refresh').set('Cookie', cookieB);
    const [r1, r2] = await Promise.all([refresh(), refresh()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.data.accessToken).toBeTruthy();
    expect(r2.body.data.accessToken).toBeTruthy();

    // Семья жива: оба новых токена валидны, список сессий доступен.
    for (const r of [r1, r2]) {
      const me = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${r.body.data.accessToken}`);
      expect(me.status).toBe(200);
    }
  });
});