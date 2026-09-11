import { NextFunction, Request, Response } from 'express';
import { AppError, errorCodes, USER_ROLES } from '@marketplace/shared';
import { prisma } from '@marketplace/db';
import {
  isAccessTokenBlacklisted,
  rotateRefreshToken,
  verifyAccessToken,
} from '../services/tokenService.js';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
      user?: {
        id: string;
        role: string;
        email: string | null;
        isBanned: boolean;
      };
    }
  }
}

export function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

export function extractTokenFromCookie(req: Request, name: string): string | null {
  return (req.cookies?.[name] as string | undefined) ?? null;
}

async function loadUser(userId: string) {
  const redis = getRedis();
  const cacheKey = `user:auth:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as { id: string; role: string; email: string; isBanned: boolean };
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, email: true, isBanned: true },
  });
  if (!user) return null;
  const data = { id: user.id, role: user.role, email: user.email, isBanned: user.isBanned };
  await redis.setex(cacheKey, 60, JSON.stringify(data));
  return data;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req);
    if (!token) {
      throw new AppError(errorCodes.UNAUTHORIZED, 'Требуется авторизация', 401);
    }
    const payload = verifyAccessToken(token);
    if (await isAccessTokenBlacklisted(payload.jti)) {
      throw new AppError(errorCodes.UNAUTHORIZED, 'Токен отозван', 401);
    }
    const user = await loadUser(payload.sub);
    if (!user) {
      throw new AppError(errorCodes.UNAUTHORIZED, 'Пользователь не найден', 401);
    }
    if (user.isBanned) {
      throw new AppError(errorCodes.FORBIDDEN, 'Аккаунт заблокирован', 403);
    }
    req.userId = user.id;
    req.userRole = user.role;
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req);
    if (!token) return next();
    const payload = verifyAccessToken(token);
    if (await isAccessTokenBlacklisted(payload.jti)) return next();
    const user = await loadUser(payload.sub);
    if (!user || user.isBanned) return next();
    req.userId = user.id;
    req.userRole = user.role;
    req.user = user;
    next();
  } catch {
    next();
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.userId || !req.userRole) {
      return next(new AppError(errorCodes.UNAUTHORIZED, 'Требуется авторизация', 401));
    }
    if (!roles.includes(req.userRole)) {
      return next(new AppError(errorCodes.FORBIDDEN, 'Недостаточно прав', 403));
    }
    next();
  };
}

export const requireAdmin = requireRole('ADMIN');
export const requireModerator = requireRole('ADMIN', 'MODERATOR');

export function isModeratorRole(role: string): boolean {
  return USER_ROLES.includes(role as (typeof USER_ROLES)[number]) && role !== 'USER';
}

/**
 * Автопродление access-токена при его близком истечении:
 * если клиент прислал refresh-токен в httpOnly cookie, а access устарел,
 * middleware выдаст новый access-токен. (упрощённая версия — без rotate)
 */
export async function refreshAccessIfNeeded(req: Request, res: Response, next: NextFunction) {
  try {
    const refresh = extractTokenFromCookie(req, 'refresh_token');
    const access = extractBearer(req);
    if (!access && refresh) {
      const { token, user } = await rotateRefreshToken(refresh, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      res.cookie('refresh_token', token, {
        httpOnly: true,
        secure: envCookieSecure(),
        sameSite: 'strict',
        maxAge: 30 * 86400_000,
        path: '/',
      });
      req.userId = user.id;
      next();
    } else if (access) {
      next();
    } else {
      next();
    }
  } catch (err) {
    logger.debug({ err }, 'refresh-if-needed skipped');
    next();
  }
}

function envCookieSecure(): boolean {
  return process.env.COOKIE_SECURE === 'true';
}
