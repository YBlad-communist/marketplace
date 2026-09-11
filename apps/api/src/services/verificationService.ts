import crypto from 'node:crypto';
import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { getRedis } from '../lib/redis.js';

export const VERIFY_CODE_TTL_MS = 10 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 5;

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

export async function verifyCode(data: {
  userId?: string;
  purpose: 'EMAIL_VERIFY' | 'PHONE_VERIFY' | 'PASSWORD_RESET';
  target: string;
  code: string;
}): Promise<{ userId: string }> {
  const codeHash = crypto.createHash('sha256').update(data.code).digest('hex');
  const record = await prisma.verificationCode.findFirst({
    where: {
      codeHash,
      purpose: data.purpose,
      target: data.target,
      consumedAt: null,
      expiresAt: { gt: new Date() },
      ...(data.userId ? { userId: data.userId } : {}),
    },
  });
  if (!record) {
    // защита от подбора: считаем неудачные попытки по цели
    const redis = getRedis();
    const attempts = await redis.incr(`verify:fail:${data.purpose}:${data.target}`);
    await redis.expire(`verify:fail:${data.purpose}:${data.target}`, VERIFY_CODE_TTL_MS / 1000);
    if (attempts >= VERIFY_MAX_ATTEMPTS) {
      await prisma.verificationCode.updateMany({
        where: { purpose: data.purpose, target: data.target, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    }
    throw new AppError(errorCodes.VALIDATION, 'Неверный или истёкший код', 400);
  }
  await prisma.verificationCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });
  return { userId: record.userId };
}
