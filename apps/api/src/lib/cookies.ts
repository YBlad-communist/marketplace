import { env } from '../config.js';

export const refreshCookieName = 'refresh_token';

export const refreshCookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/',
  domain: env.NODE_ENV === 'production' ? env.COOKIE_DOMAIN : undefined,
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
};

export const clearRefreshCookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/',
  domain: env.NODE_ENV === 'production' ? env.COOKIE_DOMAIN : undefined,
  maxAge: 0,
};
