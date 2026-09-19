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
  /** форсировать ли ключ по IP, даже если запрос авторизован */
  ipOnly?: boolean;
  /** форсировать ли ключ по userId (требует authenticate до вызова) */
  userOnly?: boolean;
}

/** Базовый ключ ведра: IP (или userId, если он известен и ipOnly не задан). */
export function keyFor(req: Request, extra?: string): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const userId = (req as Request & { userId?: string }).userId;
  return userId ? `rl:${extra ?? ''}:${userId}` : `rl:${extra ?? ''}:ip:${ip}`;
}

/** Ключ строго по IP — имя функции обещает то, что она делает. */
export function ipKeyFor(req: Request, extra?: string): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return `rl:${extra ?? ''}:ip:${ip}`;
}

/** Ключ строго по userId (используется ПОСЛЕ authenticate). */
export function userKeyFor(req: Request, extra?: string): string {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) throw new Error('userRateLimit требует authenticate перед вызовом');
  return `rl:${extra ?? ''}:user:${userId}`;
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
      const redisKey = opts.userOnly
        ? userKeyFor(req, opts.key)
        : opts.ipOnly
          ? ipKeyFor(req, opts.key)
          : keyFor(req, opts.key);
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
      // Fail-open, а не 500: Redis моргнул — ограничение временно не работает,
      // но вход/регистрация не должны падать вместе с кэшем. Анонимный 500
      // здесь хуже любого из вариантов: он валит всю аутентификацию.
      if (err instanceof AppError && err.code === errorCodes.RATE_LIMITED) return next(err);
      logger.error({ err, key: opts.key }, 'rate limit unavailable, failing open');
      next();
    }
  };
}

/** Ограничение по IP для защиты от brute-force логина (до authenticate) */
export function ipRateLimit(key: string, windowMs: number, max: number) {
  return rateLimit({ key, windowMs, max, log: true, ipOnly: true });
}

/** Ограничение по пользователю: вешает строго на userId, а не на IP. */
export function userRateLimit(key: string, windowMs: number, max: number) {
  return rateLimit({ key, windowMs, max, log: true, userOnly: true });
}
