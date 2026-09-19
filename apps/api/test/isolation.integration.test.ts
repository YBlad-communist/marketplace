import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';
import { createRefreshToken, revokeAllUserSessions, revokeSessionFamily, signAccessToken } from '../src/services/tokenService.js';
import { isFamilyRevoked } from '../src/services/tokenService.js';

const app = createApp();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

let userIdA = '';
let userIdB = '';
let adminId = '';

const unique = Date.now();

async function makeUser(role: 'USER' | 'ADMIN', tag: string) {
  const user = await prisma.user.create({
    data: {
      name: `${tag}-${unique}`,
      phone: `+7${unique.toString().slice(2)}${tag === 'ADMIN' ? '9' : '1'}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
      passwordHash: 'x',
      role,
      isVerified: true,
    },
  });
  return user;
}

beforeAll(async () => {
  await connectRedis();
  const a = await makeUser('USER', 'a');
  const b = await makeUser('USER', 'b');
  const admin = await makeUser('ADMIN', 'adm');
  userIdA = a.id;
  userIdB = b.id;
  adminId = admin.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [userIdA, userIdB, adminId] } } });
  await disconnectRedis();
});

describeInfra('изоляция: «операция над A не трогает B»', () => {
  it('revokeSessionFamily отзывает только свою семью, не семью B', async () => {
    const aToken = await createRefreshToken(userIdA, { userAgent: 'UA-A2', ip: '11.11.11.11' });
    const bToken = await createRefreshToken(userIdB, { userAgent: 'UA-B2', ip: '22.22.22.22' });

    await revokeSessionFamily(userIdA, aToken.familyId);

    expect(await isFamilyRevoked(aToken.familyId)).toBe(true);
    expect(await isFamilyRevoked(bToken.familyId)).toBe(false);
    const bRows = await prisma.refreshTokenFamily.findMany({
      where: { userId: userIdB, revokedAt: null },
    });
    expect(bRows.some((r) => r.familyId === bToken.familyId)).toBe(true);
  });

  it('revokeSessionFamily с чужим (не-своим) familyId не отзывает ничего', async () => {
    const a1 = await createRefreshToken(userIdA, { ip: '12.12.12.12' });
    const bToken = await createRefreshToken(userIdB, { ip: '23.23.23.23' });

    // B пытается отозвать семью A, подставив её familyId с токеном B:
    // револьвер требует соответствия userId+familyId, иначе — пустое действие.
    const res = await revokeSessionFamily(userIdB, a1.familyId);
    expect(res).toBe(false);
    expect(await isFamilyRevoked(a1.familyId)).toBe(false);
    expect(await isFamilyRevoked(bToken.familyId)).toBe(false);
  });

  it('revokeSessionFamily не задевает смежную семью того же пользователя', async () => {
    const a1 = await createRefreshToken(userIdA, { ip: '12.12.12.12' });
    const a2 = await createRefreshToken(userIdA, { ip: '13.13.13.13' });
    expect(a1.familyId).not.toBe(a2.familyId);

    await revokeSessionFamily(userIdA, a1.familyId);
    expect(await isFamilyRevoked(a1.familyId)).toBe(true);
    expect(await isFamilyRevoked(a2.familyId)).toBe(false);
  });

  it('revokeAllUserSessions отзывает только сессии своего пользователя', async () => {
    const aToken = await createRefreshToken(userIdA, { userAgent: 'UA-A', ip: '1.1.1.1' });
    const bToken = await createRefreshToken(userIdB, { userAgent: 'UA-B', ip: '2.2.2.2' });
    const familyA = aToken.familyId;
    const familyB = bToken.familyId;

    await revokeAllUserSessions(userIdA);

    const rowsA = await prisma.refreshTokenFamily.findMany({
      where: { userId: userIdA, revokedAt: null },
    });
    const rowsB = await prisma.refreshTokenFamily.findMany({
      where: { userId: userIdB, revokedAt: null },
    });
    expect(rowsA).toHaveLength(0);
    expect(rowsB.length).toBeGreaterThanOrEqual(1);
    expect(rowsB.some((r) => r.familyId === familyB)).toBe(true);
    expect(await isFamilyRevoked(familyA)).toBe(true);
    expect(await isFamilyRevoked(familyB)).toBe(false);
  });

  it('бан A не трогает сессии и доступ B; разбан сбрасывает кэш', async () => {
    const adminToken = signAccessToken(adminId, 'ADMIN').token;
    const accessA = signAccessToken(userIdA, 'USER').token;
    const accessB = signAccessToken(userIdB, 'USER').token;
    const familyB = (await createRefreshToken(userIdB, { ip: '3.3.3.3' })).familyId;

    await request(app)
      .post(`/api/admin/users/${userIdA}/ban`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ banned: true, reason: 'тест' })
      .expect(200);

    const blocked = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessA}`);
    expect(blocked.status).toBe(403);

    const bWorks = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessB}`);
    expect(bWorks.status).toBe(200);
    expect(await isFamilyRevoked(familyB)).toBe(false);

    // Unban: кэш авторизации инвалидируется сразу, а не через TTL.
    await request(app)
      .post(`/api/admin/users/${userIdA}/ban`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ banned: false })
      .expect(200);

    const unbanned = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessA}`);
    expect(unbanned.status).toBe(200);
  });
});