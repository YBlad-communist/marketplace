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
import {
  createVerificationCode,
  verifyCode,
  assertOtpSendAllowed,
  verifyAttemptsKey,
} from './verificationService.js';
import { enqueueSms } from './notificationService.js';
import { disconnectUserSockets } from '../lib/socket.js';
import { revokeOtherUserSessions } from './tokenService.js';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60_000;

interface AuthContext {
  userAgent?: string;
  ip?: string;
}

/**
 * П.23: ключ счётчика — пара (phone, ip), а не только phone:
 * иначе злоумышленник из чужой сети мог заблокировать чужой аккаунт,
 * перебирая пароли к его номеру.
 */
const loginFailKey = (phone: string, ip?: string) => `login:fail:${phone}:${ip ?? 'na'}`;

export async function assertNotLocked(phone: string, ip?: string): Promise<void> {
  const redis = getRedis();
  const key = loginFailKey(phone, ip);
  const attempts = Number((await redis.get(key)) ?? 0);
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    const ttlMs = await redis.pttl(key);
    const minutes = Math.max(1, Math.ceil(Math.max(ttlMs, 1000) / 60_000));
    throw new AppError(
      errorCodes.RATE_LIMITED,
      `Слишком много неудачных попыток. Попробуйте через ${minutes} мин.`,
      429
    );
  }
}

/**
 * П.23: атомарный счётчик (Redis INCR с TTL) вместо read-modify-write —
 * параллельные попытки не теряются и не обходят лимит.
 */
export async function registerLoginFailure(phone: string, ip?: string): Promise<void> {
  const redis = getRedis();
  const key = loginFailKey(phone, ip);
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, Math.ceil(LOCK_DURATION_MS / 1000)).catch(() => undefined);
  } else if (attempts >= MAX_LOGIN_ATTEMPTS) {
    // На блокировке окно продлевается: счётчик живёт ровно до конца блокировки.
    await redis.expire(key, Math.ceil(LOCK_DURATION_MS / 1000)).catch(() => undefined);
  }
  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (user) {
    // Наблюдаемость в БД (атомарный increment); для лока не используется —
    // лок живёт по паре (phone, ip) в Redis.
    await prisma.user
      .update({ where: { id: user.id }, data: { loginFailCount: { increment: 1 } } })
      .catch(() => undefined);
  }
  if (attempts === MAX_LOGIN_ATTEMPTS) {
    logSecurityEvent('account_locked', { userId: user?.id, ip });
  }
}

async function resetLoginFailures(userId: string, phone: string, ip?: string): Promise<void> {
  const redis = getRedis();
  await redis.del(loginFailKey(phone, ip)).catch(() => undefined);
  await prisma.user
    .update({ where: { id: userId }, data: { loginFailCount: 0, lockUntil: null } })
    .catch(() => undefined);
}

function hashArgon2(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
}

// П.26: фиктивная проверка для несуществующего пользователя — время ответа
// login не выдаёт, есть аккаунт или нет (защита от перебора аккаунтов).
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash('dummy-password-for-timing', {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
    });
  }
  return dummyHashPromise;
}
async function dummyArgon2Verify(password: string): Promise<void> {
  try {
    await argon2.verify(await dummyHash(), password);
  } catch {
    // игнорируем: важен только расход времени
  }
}

export async function register(input: {
  name: string;
  phone: string;
  password: string;
}): Promise<{ userId: string }> {
  // П.25: лимит отправки SMS — до создания кода, чтобы не сжигать бюджет
  // и не создавать пользователя без возможности подтверждения.
  await assertOtpSendAllowed(input.phone);
  // Хэш считаем до ветвления: путь «телефон уже занят» тратит столько же
  // времени, сколько путь создания аккаунта (п.26 — выравнивание тайминга).
  const passwordHash = await hashArgon2(input.password);
  const existing = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (existing) {
    // П.26: ответ как при успешной регистрации + SMS владельцу номера.
    // Никакого 409 — по ответу API нельзя понять, существует ли аккаунт.
    await enqueueSms(existing.phone!, 'У вас уже есть аккаунт. Войдите по этому номеру.');
    return { userId: existing.id };
  }
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
  await assertNotLocked(input.phone, ctx.ip);
  const user = await prisma.user.findUnique({ where: { phone: input.phone } });
  const hasPassword = !!user?.passwordHash;
  // П.26: пароль проверяется ДО бана, а для несуществующего аккаунта
  // выполняется фиктивная argon2-проверка — время ответа одинаково.
  const ok = hasPassword
    ? await argon2.verify(user!.passwordHash!, input.password)
    : await dummyArgon2Verify(input.password).then(() => false);
  if (!user || !hasPassword || !ok) {
    await registerLoginFailure(input.phone, ctx.ip);
    if (user) logSecurityEvent('failed_login', { userId: user.id });
    throw new AppError(errorCodes.UNAUTHORIZED, 'Неверный телефон или пароль', 401);
  }
  if (user.isBanned) {
    throw new AppError(errorCodes.FORBIDDEN, 'Аккаунт заблокирован', 403);
  }
  await resetLoginFailures(user.id, input.phone, ctx.ip);

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
  await redis.del(verifyAttemptsKey('PASSWORD_RESET', input.phone));
  await disconnectUserSockets(userId);
}

export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string }
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
  if (!user.passwordHash) {
    throw new AppError(errorCodes.CONFLICT, 'Для аккаунта не задан пароль, обратитесь в поддержку', 409);
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
  // П.28: живые сокеты отключаем сразу, не дожидаясь истечения access-токена.
  await disconnectUserSockets(userId);
  logSecurityEvent('password_changed', { userId });
}

/**
 * П.27: подтверждение смены телефона текущим паролем.
 * Общий путь для /me/phone/request и /me/phone/confirm.
 */
export async function assertCurrentPassword(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
  if (!user.passwordHash) {
    throw new AppError(errorCodes.CONFLICT, 'Для аккаунта не задан пароль, обратитесь в поддержку', 409);
  }
  const ok = await argon2.verify(user.passwordHash, password);
  if (!ok) {
    logSecurityEvent('failed_password_change', { userId });
    throw new AppError(errorCodes.VALIDATION, 'Текущий пароль неверен', 400);
  }
}

/** П.27: после смены телефона отзываем все остальные сессии пользователя. */
export async function revokeOtherSessions(userId: string, currentFamilyId: string | null): Promise<void> {
  await revokeOtherUserSessions(userId, currentFamilyId);
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
  payoutAccountId?: string | null;
  payoutOnboarded?: boolean;
  payoutMode?: string;
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
    payoutAccountId: user.payoutAccountId ?? null,
    payoutOnboarded: Boolean(user.payoutOnboarded),
    payoutMode: user.payoutMode ?? 'ACCOUNT',
    createdAt: user.createdAt,
  };
}
