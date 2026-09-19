import { NextFunction, Request, Response } from 'express';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';

const SMARTCAPTCHA_VERIFY_URL = 'https://smartcaptcha.yandexcloud.net/validate';

export async function verifySmartCaptcha(token: string | undefined, ip?: string): Promise<boolean> {
  if (!env.SMARTCAPTCHA_ENABLED || !env.SMARTCAPTCHA_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({
      secret: env.SMARTCAPTCHA_SECRET_KEY,
      token,
    });
    if (ip) form.append('ip', ip);
    const res = await fetch(SMARTCAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const json = (await res.json()) as { status?: string };
    return json.status === 'ok';
  } catch {
    return false;
  }
}

export function requireCaptcha(req: Request, _res: Response, next: NextFunction) {
  if (!env.SMARTCAPTCHA_ENABLED) return next();
  const token = (req.body as { captchaToken?: string })?.captchaToken;
  verifySmartCaptcha(token, req.ip).then((ok) => {
    if (!ok) {
      return next(new AppError(errorCodes.VALIDATION, 'Не пройдена проверка CAPTCHA', 400));
    }
    next();
  });
}

/** Одноразовая проверка: использованный токен не принимаем повторно */
export async function consumeCaptchaToken(token: string): Promise<void> {
  const redis = getRedis();
  await redis.setex(`captcha:used:${token}`, 300, '1');
}

export async function isCaptchaTokenUsed(token: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.exists(`captcha:used:${token}`)) === 1;
}