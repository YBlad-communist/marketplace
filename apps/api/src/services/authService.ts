import argon2 from 'argon2';
import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { getRedis } from '../lib/redis.js';
import { logSecurityEvent } from '../lib/logger.js';
import {
  createRefreshToken,
  revokeAllUserSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from './tokenService.js';
import { createVerificationCode, verifyCode, assertOtpSendAllowed } from './verificationService.js';
import { enqueueSms } from './notificationService.js';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60_000;

interface AuthContext {
  userAgent?: string;
  ip?: string;
}

async function assertNotLocked(phone: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (user?.lockUntil && user.lockUntil > new Date()) {
    const seconds = Math.ceil((user.lockUntil.getTime() - Date.now()) / 1000);
    throw new AppError(
      errorCodes.RATE_LIMITED,
      `Слишком много неудачных попыток. Попробуйте через ${Math.ceil(seconds / 60)} мин.`,
      429
    );
  }
}

async function registerLoginFailure(phone: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) return;
  const attempts = user.loginFailCount + 1;
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    await prisma.user.update({
      where: { id: user.id },
      data: { loginFailCount: 0, lockUntil: new Date(Date.now() + LOCK_DURATION_MS) },
    });
    logSecurityEvent('account_locked', { userId: user.id, ip: undefined });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { loginFailCount: attempts },
    });
  }
}

async function resetLoginFailures(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { loginFailCount: 0, lockUntil: null },
  });
}

function hashArgon2(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
}

export async function register(input: {
  name: string;
  phone: string;
  password: string;
}): Promise<{ userId: string }> {
  const existing = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (existing) {
    throw new AppError(errorCodes.CONFLICT, 'Пользователь с таким телефоном уже существует', 409);
  }
  const passwordHash = await hashArgon2(input.password);
  const user = await prisma.user.create({
    data: {
      name: input.name,
      phone: input.phone,
      passwordHash,
    },
  });

  const code = await createVerificationCode({
    userId: user.id,
    purpose: 'PHONE_VERIFY',
    channel: 'PHONE',
    target: user.phone!,
  });
  await enqueueSms(user.phone!, `Ваш код подтверждения: ${code}`);
  return { userId: user.id };
}

export async function login(input: { phone: string; password: string }, ctx: AuthContext) {
  await assertNotLocked(input.phone);
  const user = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (!user || !user.passwordHash) {
    await registerLoginFailure(input.phone);
    throw new AppError(errorCodes.UNAUTHORIZED, 'Неверный телефон или пароль', 401);
  }
  if (user.isBanned) {
    throw new AppError(errorCodes.FORBIDDEN, 'Аккаунт заблокирован', 403);
  }
  const ok = await argon2.verify(user.passwordHash, input.password);
  if (!ok) {
    await registerLoginFailure(input.phone);
    logSecurityEvent('failed_login', { userId: user.id });
    throw new AppError(errorCodes.UNAUTHORIZED, 'Неверный телефон или пароль', 401);
  }
  await resetLoginFailures(user.id);

  const access = signAccessToken(user.id, user.role);
  const refresh = await createRefreshToken(user.id, {
    userAgent: ctx.userAgent,
    ip: ctx.ip,
  });
  return {
    user: publicUser(user),
    accessToken: access.token,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export async function refresh(refreshToken: string, ctx: AuthContext) {
  const { token, expiresAt, user } = await rotateRefreshToken(refreshToken, ctx);
  const access = signAccessToken(user.id, user.role);
  return { accessToken: access.token, refreshToken: token, refreshExpiresAt: expiresAt };
}

export async function logout(refreshToken: string | null): Promise<void> {
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
}

export async function requestPhoneVerification(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
  if (user.phoneVerifiedAt || !user.phone) return;
  // Разные вёдра по номеру и по пользователю: нельзя бомбить чужой номер
  // своей сессией и нельзя сжигать бюджет SMS частой «повторной отправкой».
  await assertOtpSendAllowed(user.phone, userId);
  const code = await createVerificationCode({
    userId,
    purpose: 'PHONE_VERIFY',
    channel: 'PHONE',
    target: user.phone,
  });
  await enqueueSms(user.phone, `Ваш код подтверждения: ${code}`);
}

export async function verifyPhone(userId: string, code: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
  if (!user.phone) throw new AppError(errorCodes.VALIDATION, 'Телефон не указан', 400);
  await verifyCode({ userId, purpose: 'PHONE_VERIFY', target: user.phone, code });
  await prisma.user.update({
    where: { id: userId },
    data: { phoneVerifiedAt: new Date(), isVerified: true },
  });
}

export async function requestPasswordReset(phone: string): Promise<void> {
  // Лимит по цели (номер) работает и для несуществующих аккаунтов: бомбить
  // чужой номер через /password/forgot нельзя, и не палим existence-статус.
  await assertOtpSendAllowed(phone);
  const user = await prisma.user.findUnique({ where: { phone } });
  if (user) {
    const code = await createVerificationCode({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      channel: 'PHONE',
      target: user.phone!,
    });
    await enqueueSms(user.phone!, `Ваш код для сброса пароля: ${code}`);
  }
  // единый ответ против enumeration-атаки
}

export async function resetPassword(input: { phone: string; code: string; newPassword: string }): Promise<void> {
  const { userId } = await verifyCode({
    purpose: 'PASSWORD_RESET',
    target: input.phone,
    code: input.code,
  });
  const passwordHash = await hashArgon2(input.newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, loginFailCount: 0, lockUntil: null },
  });
  // Сброс через «забыли пароль» — неаутентифицированный флоу: выкидываем
  // вообще все сессии, включая возможную сессию злоумышленника.
  await revokeAllUserSessions(userId);
  const redis = getRedis();
  await redis.del(`verify:fail:PASSWORD_RESET:${input.phone}`);
}

export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string }
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
  if (!user.passwordHash) {
    throw new AppError(errorCodes.CONFLICT, 'Пароль не задан (OAuth-аккаунт)', 409);
  }
  const ok = await argon2.verify(user.passwordHash, input.currentPassword);
  if (!ok) {
    logSecurityEvent('failed_password_change', { userId });
    throw new AppError(errorCodes.VALIDATION, 'Текущий пароль неверен', 400);
  }
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashArgon2(input.newPassword) },
  });
  // Отзываем все refresh-сессии: смена пароля часто означает компрометацию.
  // Текущий access-токен доживёт свой TTL (<=15 мин), затем потребуется новый вход.
  await revokeAllUserSessions(userId);
  logSecurityEvent('password_changed', { userId });
}

export function publicUser(user: {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  avatarUrl: string | null;
  city: string | null;
  role: string;
  isVerified: boolean;
  isBanned: boolean;
  rating: number;
  ratingCount: number;
  yookassaShopId: string | null;
  yookassaOnboarded: boolean;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    avatarUrl: user.avatarUrl,
    city: user.city,
    role: user.role,
    isVerified: user.isVerified,
    isBanned: user.isBanned,
    rating: user.rating,
    ratingCount: user.ratingCount,
    yookassaShopId: user.yookassaShopId,
    yookassaOnboarded: user.yookassaOnboarded,
    createdAt: user.createdAt,
  };
}

export const isPasswordResetTargetUsed = () => false;
