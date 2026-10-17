import crypto from 'node:crypto';
import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { getRedis } from '../lib/redis.js';

export const VERIFY_CODE_TTL_MS = 10 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 5;

// Лимиты на отправку OTP (SMS/почта): защита от SMS-бомбинга и сжигания бюджета.
export const OTP_MIN_INTERVAL_MS = 60_000;
export const OTP_HOUR_MS = 3_600_000;
export const OTP_HOUR_MAX = 5;
export const OTP_DAY_MS = 86_400_000;
export const OTP_DAY_MAX = 10;

export interface OtpBucket {
  key: string;
  windowMs: number;
  max: number;
}

/**
 * Вёдра лимита отправки кода:
 * - не чаще 1 запроса в 60 сек на целевой номер/email (otp:send:{target});
 * - не больше 5 в час на цель;
 * - не больше 10 в сутки на userId (otp:send:user:{userId}).
 */
export function otpBuckets(target: string, userId?: string): OtpBucket[] {
  const buckets: OtpBucket[] = [
    { key: `otp:send:${target}`, windowMs: OTP_MIN_INTERVAL_MS, max: 1 },
    { key: `otp:send:${target}`, windowMs: OTP_HOUR_MS, max: OTP_HOUR_MAX },
  ];
  if (userId) {
    buckets.push({ key: `otp:send:user:${userId}`, windowMs: OTP_DAY_MS, max: OTP_DAY_MAX });
  }
  return buckets;
}

/** Сколько мс ждать до конца окна, если count превысило max ведра (иначе 0). */
export function otpBlockedRetryMs(bucket: OtpBucket, now: number, count: number): number {
  if (count <= bucket.max) return 0;
  const windowStart = Math.floor(now / bucket.windowMs) * bucket.windowMs;
  return Math.max(1000, windowStart + bucket.windowMs - now);
}

export async function assertOtpSendAllowed(target: string, userId?: string): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const buckets = otpBuckets(target, userId);

  let retryAfterMs = 0;
  for (const bucket of buckets) {
    const fullKey = `${bucket.key}:${Math.floor(now / bucket.windowMs) * bucket.windowMs}`;
    const count = await redis.incr(fullKey);
    if (count === 1) {
      await redis.expire(fullKey, Math.ceil(bucket.windowMs / 1000)).catch(() => undefined);
    }
    retryAfterMs = Math.max(retryAfterMs, otpBlockedRetryMs(bucket, now, count));
  }

  if (retryAfterMs > 0) {
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    throw new AppError(
      errorCodes.RATE_LIMITED,
      `Слишком много запросов кода. Повторите через ${retryAfterSeconds} сек.`,
      429,
      undefined,
      { retryAfterSeconds }
    );
  }
}

export function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export async function createVerificationCode(data: {
  userId: string;
  purpose: 'EMAIL_VERIFY' | 'PHONE_VERIFY' | 'PASSWORD_RESET';
  channel: 'EMAIL' | 'PHONE';
  target: string;
}): Promise<string> {
  const code = generateCode();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  await prisma.verificationCode.updateMany({
    where: { userId: data.userId, purpose: data.purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.verificationCode.create({
    data: {
      userId: data.userId,
      purpose: data.purpose,
      channel: data.channel,
      target: data.target,
      codeHash,
      expiresAt: new Date(Date.now() + VERIFY_CODE_TTL_MS),
    },
  });
  return code;
}

/** Ключ счётчика попыток подбора кода по (purpose, target). */
export function verifyAttemptsKey(purpose: string, target: string): string {
  return `verify:attempts:${purpose}:${target}`;
}

/** Погасить все активные коды по цели (превышено число попыток). */
async function burnCodes(purpose: string, target: string): Promise<void> {
  await prisma.verificationCode.updateMany({
    where: { purpose, target, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export async function verifyCode(data: {
  userId?: string;
  purpose: 'EMAIL_VERIFY' | 'PHONE_VERIFY' | 'PASSWORD_RESET';
  target: string;
  code: string;
}): Promise<{ userId: string }> {
  const redis = getRedis();
  const attemptsKey = verifyAttemptsKey(data.purpose, data.target);

  // П.24: сначала атомарно считаем попытку (INCR — не read-modify-write),
  // и только потом сравниваем сам код. Иначе параллельные запросы обходят лимит.
  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) {
    await redis.expire(attemptsKey, Math.ceil(VERIFY_CODE_TTL_MS / 1000)).catch(() => undefined);
  }
  if (attempts > VERIFY_MAX_ATTEMPTS) {
    await burnCodes(data.purpose, data.target);
    throw new AppError(errorCodes.VALIDATION, 'Неверный или истёкший код', 400);
  }

  const codeHash = crypto.createHash('sha256').update(data.code).digest('hex');
  const record = await prisma.verificationCode.findFirst({
    where: {
      purpose: data.purpose,
      target: data.target,
      consumedAt: null,
      expiresAt: { gt: new Date() },
      ...(data.userId ? { userId: data.userId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  const ok = !!record && timingSafeEqualHex(record.codeHash, codeHash);
  if (!record || !ok) {
    // Счётчик неудач хранится и в записи VerificationCode (для аудита/расследований).
    if (record) {
      await prisma.verificationCode
        .update({ where: { id: record.id }, data: { attempts: { increment: 1 } } })
        .catch(() => undefined);
    }
    throw new AppError(errorCodes.VALIDATION, 'Неверный или истёкший код', 400);
  }
  await prisma.verificationCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });
  await redis.del(attemptsKey).catch(() => undefined);
  return { userId: record.userId };
}
