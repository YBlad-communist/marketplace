import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { prisma } from '@marketplace/db';
import { createApp } from '../src/app.js';
import { connectRedis, disconnectRedis, getRedis } from '../src/lib/redis.js';
import { env } from '../src/config.js';
import { isInfraAvailable } from './helpers.js';
import { registerLoginFailure, assertNotLocked } from '../src/services/authService.js';
import {
  createVerificationCode,
  verifyCode,
  VERIFY_MAX_ATTEMPTS,
} from '../src/services/verificationService.js';
import { disconnectUserSockets } from '../src/lib/socket.js';
import { createMessage, assertParticipant, deleteConversation } from '../src/services/conversationService.js';

vi.mock('../src/services/notificationService.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/notificationService.js')>();
  return { ...mod, enqueueSms: vi.fn(async () => undefined) };
});
import { enqueueSms } from '../src/services/notificationService.js';

const app = createApp();
const password = 'Strong123!';
const unique = Date.now();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

function phone(n: string): string {
  return `+7${unique.toString().slice(-8)}${n}`;
}

function lastSms(): string {
  const calls = vi.mocked(enqueueSms).mock.calls;
  return String(calls[calls.length - 1]?.[1] ?? '');
}

function lastSmsCode(): string {
  return lastSms().match(/\d{6}/)?.[0] ?? '';
}

async function registerUser(name: string, p: string) {
  return request(app)
    .post('/api/auth/register')
    .send({ name, phone: p, password, confirmPassword: password });
}

async function login(p: string, pass: string, xff?: string) {
  const req = request(app).post('/api/auth/login');
  if (xff) req.set('X-Forwarded-For', xff);
  return req.send({ phone: p, password: pass });
}

function cookieHeader(raw: string[] | undefined): string {
  return (raw ?? []).map((c) => c.split(';')[0]).join('; ');
}

/** Удалить все вёдра OTP-лимита на номер (чтобы повторная отправка прошла). */
async function clearOtpBuckets(target: string): Promise<void> {
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `otp:send:${target}:*`, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

async function createUserRow(p: string, name = 'Тест') {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
  return prisma.user.create({ data: { name, phone: p, passwordHash } });
}

function wrongOf(code: string): string {
  return code === '999999' ? '999998' : '999999';
}

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('п.23: блокировка логина — атомарный счётчик по паре (phone, ip)', () => {
  it('блокировка по (phone, ip): чужой аккаунт и другой IP не блокируются', async () => {
    const p = phone('231');
    await registerUser('П23', p);
    const ipA = '203.0.113.23';
    const ipB = '198.51.100.23';
    for (let i = 0; i < 5; i++) {
      const res = await login(p, 'WrongPass1', ipA);
      expect(res.status).toBe(401);
    }
    const lockedA = await login(p, 'WrongPass1', ipA);
    expect(lockedA.status).toBe(429);
    // Тот же номер с другого IP не заблокирован: пароль просто неверный.
    const fromB = await login(p, 'WrongPass1', ipB);
    expect(fromB.status).toBe(401);
    const okB = await login(p, password, ipB);
    expect(okB.status).toBe(200);
  });

  it('счётчик атомарный (Redis INCR): параллельные ошибки не теряются', async () => {
    const p = phone('232');
    const ip = '203.0.113.99';
    await Promise.all(Array.from({ length: 5 }, () => registerLoginFailure(p, ip)));
    const count = Number((await getRedis().get(`login:fail:${p}:${ip}`)) ?? 0);
    expect(count).toBe(5);
    await expect(assertNotLocked(p, ip)).rejects.toMatchObject({ statusCode: 429 });
  });
});

describeInfra('п.24: verifyCode — попытки атомарно ДО сравнения, timingSafeEqual, счётчик в записи', () => {
  it('каждая неудачная попытка увеличивает attempts в записи VerificationCode', async () => {
    const target = phone('241');
    const user = await createUserRow(target);
    const code = await createVerificationCode({
      userId: user.id,
      purpose: 'PHONE_VERIFY',
      channel: 'PHONE',
      target,
    });
    await expect(
      verifyCode({ userId: user.id, purpose: 'PHONE_VERIFY', target, code: wrongOf(code) })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      verifyCode({ userId: user.id, purpose: 'PHONE_VERIFY', target, code: wrongOf(code) })
    ).rejects.toMatchObject({ statusCode: 400 });
    const record = await prisma.verificationCode.findFirst({
      where: { target, purpose: 'PHONE_VERIFY' },
      orderBy: { createdAt: 'desc' },
    });
    expect(record?.attempts).toBe(2);
  });

  it('после превышения 5 попыток коды гасятся — верный код не проходит', async () => {
    const target = phone('242');
    const user = await createUserRow(target);
    const code = await createVerificationCode({
      userId: user.id,
      purpose: 'PHONE_VERIFY',
      channel: 'PHONE',
      target,
    });
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i++) {
      await expect(
        verifyCode({ userId: user.id, purpose: 'PHONE_VERIFY', target, code: wrongOf(code) })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    // превышение: гасим все коды
    await expect(
      verifyCode({ userId: user.id, purpose: 'PHONE_VERIFY', target, code: wrongOf(code) })
    ).rejects.toMatchObject({ statusCode: 400 });
    const record = await prisma.verificationCode.findFirst({
      where: { target, purpose: 'PHONE_VERIFY' },
      orderBy: { createdAt: 'desc' },
    });
    expect(record?.consumedAt).not.toBeNull();
    await expect(
      verifyCode({ userId: user.id, purpose: 'PHONE_VERIFY', target, code })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('верный код в пределах лимита проходит и погашается', async () => {
    const target = phone('243');
    const user = await createUserRow(target);
    const code = await createVerificationCode({
      userId: user.id,
      purpose: 'PHONE_VERIFY',
      channel: 'PHONE',
      target,
    });
    const res = await verifyCode({ userId: user.id, purpose: 'PHONE_VERIFY', target, code });
    expect(res.userId).toBe(user.id);
  });
});

describeInfra('п.25: OTP-лимит на register и одноразовость капчи', () => {
  it('register забирает ведро OTP-лимита: немедленный /verification/request -> 429', async () => {
    const p = phone('251');
    const reg = await registerUser('П25', p);
    expect(reg.status).toBe(201);
    const loginRes = await login(p, password);
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.data.accessToken as string;
    const otp = await request(app)
      .post('/api/auth/verification/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'phone' });
    expect(otp.status).toBe(429);
    expect(Number(otp.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('токен капчи одноразовый: повторный requireCaptcha с тем же токеном -> 400', async () => {
    const prevEnabled = env.SMARTCAPTCHA_ENABLED;
    const prevKey = env.SMARTCAPTCHA_SECRET_KEY;
    env.SMARTCAPTCHA_ENABLED = true;
    env.SMARTCAPTCHA_SECRET_KEY = 'test-secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ status: 'ok' }) })));
    try {
      const { requireCaptcha } = await import('../src/middleware/captcha.js');
      const token = `tok-${Date.now()}`;
      const run = (t: string) =>
        new Promise<{ ok: boolean }>((resolve) => {
          requireCaptcha(
            { body: { captchaToken: t }, ip: '1.2.3.4' } as never,
            {} as never,
            (err?: unknown) => resolve({ ok: !err })
          );
        });
      expect((await run(token)).ok).toBe(true);
      expect((await run(token)).ok).toBe(false);
    } finally {
      env.SMARTCAPTCHA_ENABLED = prevEnabled;
      env.SMARTCAPTCHA_SECRET_KEY = prevKey;
      vi.unstubAllGlobals();
    }
  });
});

describeInfra('п.26: анаморфизм ответов register/login', () => {
  it('register на существующий телефон -> 201 как при успехе, без создания аккаунта', async () => {
    const p = phone('261');
    const first = await registerUser('П26', p);
    expect(first.status).toBe(201);
    await clearOtpBuckets(p);
    const before = await prisma.user.count({ where: { phone: p } });
    const second = await registerUser('П26-другой', p);
    expect(second.status).toBe(201);
    expect(typeof second.body.data.userId).toBe('string');
    const after = await prisma.user.count({ where: { phone: p } });
    expect(after).toBe(before);
    expect(lastSms()).toContain('уже есть аккаунт');
  });

  it('в login пароль проверяется до бана: неверный пароль всегда 401', async () => {
    const p = phone('262');
    await registerUser('П26b', p);
    await prisma.user.update({ where: { phone: p }, data: { isBanned: true } });
    const wrong = await login(p, 'WrongPass1');
    expect(wrong.status).toBe(401);
    const correct = await login(p, password);
    expect(correct.status).toBe(403);
    await prisma.user.update({ where: { phone: p }, data: { isBanned: false } });
  });

  it('ответ блокировки одинаков для существующего и несуществующего телефона', async () => {
    const ip = '203.0.113.26';
    const existing = phone('263');
    const missing = phone('264');
    await registerUser('П26c', existing);
    for (let i = 0; i < 5; i++) {
      expect((await login(existing, 'WrongPass1', ip)).status).toBe(401);
      expect((await login(missing, 'WrongPass1', ip)).status).toBe(401);
    }
    const lockExisting = await login(existing, 'WrongPass1', ip);
    const lockMissing = await login(missing, 'WrongPass1', ip);
    expect(lockExisting.status).toBe(429);
    expect(lockMissing.status).toBe(429);
    expect(lockExisting.body.error.code).toBe(lockMissing.body.error.code);
  });
});

describeInfra('п.27: смена телефона требует пароль и отзывает остальные сессии', () => {
  it('/me/phone/request без пароля -> 400; с неверным паролем -> 400', async () => {
    const p = phone('271');
    await registerUser('П27', p);
    const loginRes = await login(p, password);
    const token = loginRes.body.data.accessToken as string;
    const noPass = await request(app)
      .post('/api/users/me/phone/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: phone('279') });
    expect(noPass.status).toBe(400);
    const badPass = await request(app)
      .post('/api/users/me/phone/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: phone('279'), password: 'WrongPass1' });
    expect(badPass.status).toBe(400);
  });

  it('confirm меняет телефон и отзывает остальные сессии, текущая жива', async () => {
    const p = phone('272');
    await registerUser('П27b', p);
    const loginA = await login(p, password, '203.0.113.70');
    const loginB = await login(p, password, '203.0.113.71');
    expect(loginA.status).toBe(200);
    expect(loginB.status).toBe(200);
    const tokenA = loginA.body.data.accessToken as string;
    const cookieA = cookieHeader(loginA.headers['set-cookie'] as unknown as string[]);
    const cookieB = cookieHeader(loginB.headers['set-cookie'] as unknown as string[]);
    const newPhone = phone('278');
    const reqRes = await request(app)
      .post('/api/users/me/phone/request')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ phone: newPhone, password });
    expect(reqRes.status).toBe(200);
    const code = lastSmsCode();
    expect(code).toMatch(/^\d{6}$/);
    const confirm = await request(app)
      .post('/api/users/me/phone/confirm')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Cookie', cookieA)
      .send({ phone: newPhone, code, password });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.user.phone).toBe(newPhone);
    // Сессия B отозвана (refresh не прокручивается), текущая A жива.
    const refreshB = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieB)
      .send({});
    expect(refreshB.status).toBe(401);
    const meA = await request(app).get('/api/users/me').set('Authorization', `Bearer ${tokenA}`);
    expect(meA.status).toBe(200);
  });
});

describeInfra('п.28: сокет-связанная логика — бан в createMessage, кэш участников, disconnect', () => {
  it('createMessage проверяет isBanned: забаненный не может писать', async () => {
    const seller = await createUserRow(phone('281'), 'Продавец');
    const buyer = await createUserRow(phone('282'), 'Покупатель');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: seller.id }, { userId: buyer.id }] } },
    });
    await prisma.user.update({ where: { id: buyer.id }, data: { isBanned: true } });
    await expect(
      createMessage({ conversationId: conv.id, userId: buyer.id, text: 'привет' })
    ).rejects.toMatchObject({ statusCode: 403 });
    // разбаненный снова может писать
    await prisma.user.update({ where: { id: buyer.id }, data: { isBanned: false } });
    const ok = await createMessage({ conversationId: conv.id, userId: buyer.id, text: 'привет' });
    expect(ok).toMatchObject({ text: 'привет' });
  });

  it('кэш участников (30 с) инвалидируется при hard delete чата', async () => {
    const a = await createUserRow(phone('283'), 'A');
    const b = await createUserRow(phone('284'), 'B');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } },
    });
    await assertParticipant(conv.id, a.id);
    expect(await getRedis().exists(`chat:conv:${conv.id}`)).toBe(1);
    // П.30: первое удаление — мягкое скрытие (кэш остаётся, чат существует).
    const soft = await deleteConversation(conv.id, a.id);
    expect(soft.hardDeleted).toBe(false);
    await assertParticipant(conv.id, a.id);
    // Оба скрыли — hard delete: кэш инвалидирован, чата нет.
    const hard = await deleteConversation(conv.id, b.id);
    expect(hard.hardDeleted).toBe(true);
    expect(await getRedis().exists(`chat:conv:${conv.id}`)).toBe(0);
    await expect(assertParticipant(conv.id, a.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('disconnectUserSockets безопасен при неинициализированном io', async () => {
    await expect(disconnectUserSockets('nonexistent-user')).resolves.toBeUndefined();
  });
});

describeInfra('п.29: logout blacklist текущего access-токена', () => {
  it('после logout тот же access-токен -> 401', async () => {
    const p = phone('291');
    await registerUser('П29', p);
    const loginRes = await login(p, password);
    const token = loginRes.body.data.accessToken as string;
    const me1 = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);
    expect(me1.status).toBe(200);
    const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(out.status).toBe(200);
    const me2 = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);
    expect(me2.status).toBe(401);
  });

  it('logout без токенов отвечает 200 (идемпотентный выход)', async () => {
    const out = await request(app).post('/api/auth/logout');
    expect(out.status).toBe(200);
  });
});
