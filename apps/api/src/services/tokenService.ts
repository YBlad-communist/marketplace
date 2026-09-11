import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { logSecurityEvent } from '../lib/logger.js';

export interface AccessTokenPayload {
  sub: string;
  role: string;
  type: 'access';
  jti: string;
}

export interface RefreshRecord {
  token: string;
  hashed: string;
  familyId: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function signAccessToken(userId: string, role: string): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { type: 'access', role, jti },
    env.JWT_ACCESS_SECRET,
    {
      subject: userId,
      issuer: env.JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    }
  );
  return { token, jti };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      algorithms: ['HS256'],
    }) as unknown as AccessTokenPayload & jwt.JwtPayload;
    if (payload.type !== 'access' || !payload.sub || !payload.jti) {
      throw new Error('bad payload');
    }
    return payload;
  } catch {
    throw new AppError(errorCodes.UNAUTHORIZED, 'Токен доступа недействителен или истёк', 401);
  }
}

export async function isAccessTokenBlacklisted(jti: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(`at:blacklist:${jti}`);
  return exists === 1;
}

export async function blacklistAccessToken(jti: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  await redis.setex(`at:blacklist:${jti}`, ttlSeconds, '1');
}

export async function isFamilyRevoked(familyId: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(`rt:family:${familyId}:revoked`);
  return exists === 1;
}

export async function revokeFamily(familyId: string): Promise<void> {
  const redis = getRedis();
  await redis.setex(`rt:family:${familyId}:revoked`, env.REFRESH_TOKEN_TTL_DAYS * 86400, '1');
}

export async function createRefreshToken(
  userId: string,
  ctx: { userAgent?: string; ip?: string }
): Promise<{ token: string; familyId: string; expiresAt: Date }> {
  const familyId = crypto.randomUUID();
  const token = crypto.randomBytes(48).toString('base64url');
  const hashed = hashToken(token);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);

  await prisma.refreshTokenFamily.create({
    data: {
      userId,
      familyId,
      tokenHash: hashed,
      expiresAt,
      userAgent: ctx.userAgent?.slice(0, 300),
      ip: ctx.ip?.slice(0, 45),
    },
  });
  return { token, familyId, expiresAt };
}

/**
 * Ротация refresh-токена. Возвращает новый токен.
 * При повторном использовании старого токена отзывает всю семью.
 */
export async function rotateRefreshToken(
  oldToken: string,
  ctx: { userAgent?: string; ip?: string }
): Promise<{ token: string; familyId: string; expiresAt: Date; user: { id: string; role: string } }> {
  const hashed = hashToken(oldToken);
  const record = await prisma.refreshTokenFamily.findUnique({
    where: { tokenHash: hashed },
  });

  if (!record || record.expiresAt < new Date()) {
    throw new AppError(errorCodes.UNAUTHORIZED, 'Refresh-токен недействителен', 401);
  }
  if (record.revokedAt) {
    // Повторное использование уже отозванного токена — детект компрометации.
    await revokeFamily(record.familyId);
    await prisma.refreshTokenFamily.updateMany({
      where: { familyId: record.familyId },
      data: { revokedAt: new Date() },
    });
    logSecurityEvent('refresh_token_reuse_detected', { familyId: record.familyId });
    throw new AppError(errorCodes.UNAUTHORIZED, 'Сессия отозвана, войдите снова', 401);
  }
  if (await isFamilyRevoked(record.familyId)) {
    throw new AppError(errorCodes.UNAUTHORIZED, 'Сессия отозвана, войдите снова', 401);
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user || user.isBanned) {
    await revokeFamily(record.familyId);
    throw new AppError(errorCodes.UNAUTHORIZED, 'Аккаунт недоступен', 401);
  }

  const token = crypto.randomBytes(48).toString('base64url');
  const nextHash = hashToken(token);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);

  await prisma.$transaction([
    prisma.refreshTokenFamily.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedBy: nextHash },
    }),
    prisma.refreshTokenFamily.create({
      data: {
        userId: record.userId,
        familyId: record.familyId,
        tokenHash: nextHash,
        expiresAt,
        userAgent: ctx.userAgent?.slice(0, 300),
        ip: ctx.ip?.slice(0, 45),
      },
    }),
  ]);

  return { token, familyId: record.familyId, expiresAt, user: { id: user.id, role: user.role } };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const hashed = hashToken(token);
  const record = await prisma.refreshTokenFamily.findUnique({ where: { tokenHash: hashed } });
  if (record) {
    await prisma.refreshTokenFamily.updateMany({
      where: { familyId: record.familyId },
      data: { revokedAt: new Date() },
    });
    await revokeFamily(record.familyId);
  }
}

export async function cleanupExpiredTokens(): Promise<void> {
  await prisma.refreshTokenFamily.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }] },
  });
}
