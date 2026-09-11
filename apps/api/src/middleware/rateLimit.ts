import { NextFunction, Request, Response } from 'express';
import { getRedis } from '../lib/redis.js';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { logger } from '../lib/logger.js';

export interface RateLimitOptions {
  key: string;
  windowMs: number;
  max: number;
  /** возвращать ли 429 или заглушку для rate-limit по ip */
  respond?: boolean;
  /** логировать ли превышение */
  log?: boolean;
}

export function keyFor(req: Request, extra?: string): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const userId = (req as Request & { userId?: string }).userId;
  return userId ? `rl:${extra ?? ''}:${userId}` : `rl:${extra ?? ''}:ip:${ip}`;
}

export async function checkRateLimit(
  redisKey: string,
  windowMs: number,
  max: number
): Promise<{ allowed: boolean; remaining: number }> {
  const redis = getRedis();
  const now = Date.now();
  const bucketStart = Math.floor(now / windowMs) * windowMs;
  const fullKey = `${redisKey}:${bucketStart}`;
  const ttl = windowMs / 1000;

  const count = await redis.incr(fullKey);
  if (count === 1) {
    await redis.expire(fullKey, Math.ceil(ttl));
  }
  return { allowed: count <= max, remaining: Math.max(0, max - count) };
}

export function rateLimit(opts: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!env.RATE_LIMIT_ENABLED) return next();
    try {
      const redisKey = keyFor(req, opts.key);
      const { allowed, remaining } = await checkRateLimit(redisKey, opts.windowMs, opts.max);
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      if (!allowed) {
        if (opts.log) {
          logger.warn({ rateLimit: true, key: opts.key, ip: req.ip }, 'rate limit exceeded');
        }
        if (opts.respond === false) return next();
        throw new AppError(
          errorCodes.RATE_LIMITED,
          'Слишком много запросов. Попробуйте позже.',
          429
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Ограничение по IP для защиты от brute-force логина */
export function ipRateLimit(key: string, windowMs: number, max: number) {
  return rateLimit({ key, windowMs, max, log: true });
}
