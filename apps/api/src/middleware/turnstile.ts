import { NextFunction, Request, Response } from 'express';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  if (!env.TURNSTILE_ENABLED || !env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
    });
    if (ip) form.append('remoteip', ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const json = (await res.json()) as { success: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

export function requireTurnstile(req: Request, _res: Response, next: NextFunction) {
  if (!env.TURNSTILE_ENABLED) return next();
  const token = (req.body as { captchaToken?: string })?.captchaToken;
  verifyTurnstile(token, req.ip).then((ok) => {
    if (!ok) {
      return next(new AppError(errorCodes.VALIDATION, 'Не пройдена проверка CAPTCHA', 400));
    }
    next();
  });
}

/** Одноразовая проверка: использованный токен не принимаем повторно */
export async function consumeTurnstileToken(token: string): Promise<void> {
  const redis = getRedis();
  await redis.setex(`captcha:used:${token}`, 300, '1');
}

export async function isTurnstileTokenUsed(token: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.exists(`captcha:used:${token}`)) === 1;
}
