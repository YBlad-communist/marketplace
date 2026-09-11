import crypto from 'node:crypto';
import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { signAccessToken, createRefreshToken } from './tokenService.js';
import { publicUser } from './authService.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export function googleAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_REDIRECT_URL!,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function createOAuthState(): Promise<string> {
  const state = crypto.randomBytes(32).toString('base64url');
  const redis = getRedis();
  await redis.setex(`oauth:state:${state}`, 600, '1');
  return state;
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.del(`oauth:state:${state}`);
  return exists === 1;
}

interface GoogleTokens {
  access_token: string;
  id_token: string;
}

async function exchangeCode(code: string): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: env.GOOGLE_REDIRECT_URL!,
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new AppError(errorCodes.UNAUTHORIZED, 'Не удалось обменять код Google', 401);
  }
  return (await res.json()) as GoogleTokens;
}

async function fetchGoogleProfile(accessToken: string) {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new AppError(errorCodes.UNAUTHORIZED, 'Не удалось получить профиль Google', 401);
  }
  return (await res.json()) as {
    id: string;
    email: string;
    name: string;
    picture?: string;
  };
}

export async function googleCallback(
  code: string,
  ctx: { userAgent?: string; ip?: string }
) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URL) {
    throw new AppError(errorCodes.INTERNAL, 'Google OAuth не настроен', 500);
  }
  const tokens = await exchangeCode(code);
  const profile = await fetchGoogleProfile(tokens.access_token);

  let user = await prisma.user.findUnique({ where: { googleId: profile.id } });
  if (!user) {
    user = await prisma.user.findUnique({ where: { email: profile.email } });
    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId: profile.id, emailVerifiedAt: user.emailVerifiedAt ?? new Date(), isVerified: true },
      });
    } else {
      user = await prisma.user.create({
        data: {
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.picture ?? null,
          googleId: profile.id,
          isVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
    }
  }
  if (user.isBanned) {
    throw new AppError(errorCodes.FORBIDDEN, 'Аккаунт заблокирован', 403);
  }

  const access = signAccessToken(user.id, user.role);
  const refresh = await createRefreshToken(user.id, { userAgent: ctx.userAgent, ip: ctx.ip });
  return {
    user: publicUser(user),
    accessToken: access.token,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}
