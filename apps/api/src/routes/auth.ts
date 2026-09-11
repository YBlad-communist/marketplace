import { Router } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  oauthExchangeSchema,
  refreshTokenSchema,
  registerSchema,
  requestVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  AppError,
  errorCodes,
} from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate, extractTokenFromCookie } from '../middleware/auth.js';
import { ipRateLimit } from '../middleware/rateLimit.js';
import { requireTurnstile } from '../middleware/turnstile.js';
import * as authService from '../services/authService.js';
import * as oauthService from '../services/oauthService.js';
import { refreshCookieName, refreshCookieOptions, clearRefreshCookieOptions } from '../lib/cookies.js';
import { logSecurityEvent } from '../lib/logger.js';
import { env } from '../config.js';

const router: Router = Router();

function setRefreshCookie(res: { cookie: (n: string, v: string, o: object) => void }, token: string) {
  res.cookie(refreshCookieName, token, refreshCookieOptions);
}

router.post(
  '/register',
  ipRateLimit('auth:register', 60_000, 10),
  requireTurnstile,
  validate(registerSchema),
  async (req, res, next) => {
    try {
      const { userId } = await authService.register(req.body);
      res.status(201).json({ data: { userId } });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/login',
  ipRateLimit('auth:login', 60_000, 10),
  requireTurnstile,
  validate(loginSchema),
  async (req, res, next) => {
    try {
      const result = await authService.login(req.body, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      setRefreshCookie(res, result.refreshToken);
      res.json({
        data: {
          user: result.user,
          accessToken: result.accessToken,
          refreshExpiresAt: result.refreshExpiresAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/refresh', ipRateLimit('auth:refresh', 60_000, 30), async (req, res, next) => {
  try {
    const body = refreshTokenSchema.parse({
      refreshToken: extractTokenFromCookie(req, refreshCookieName) ?? req.body.refreshToken,
    });
    const result = await authService.refresh(body.refreshToken, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setRefreshCookie(res, result.refreshToken);
    res.json({ data: { accessToken: result.accessToken, refreshExpiresAt: result.refreshExpiresAt } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = extractTokenFromCookie(req, refreshCookieName) ?? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined);
    await authService.logout(token);
    if (req.userId) logSecurityEvent('logout', { userId: req.userId });
    res.clearCookie(refreshCookieName, clearRefreshCookieOptions);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/verification/request', authenticate, validate(requestVerificationSchema), async (req, res, next) => {
  try {
    // телефонная верификация — код отправляется через SMS.RU worker (см. apps/worker/src/smsru.ts)
    await authService.requestPhoneVerification(req.userId!);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/verification/verify', authenticate, validate(verifyEmailSchema), async (req, res, next) => {
  try {
    await authService.verifyPhone(req.userId!, req.body.code);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/password/forgot',
  ipRateLimit('auth:forgot', 60_000, 5),
  validate(forgotPasswordSchema),
  async (req, res, next) => {
    try {
      await authService.requestPasswordReset(req.body.phone);
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/password/reset',
  ipRateLimit('auth:reset', 60_000, 5),
  validate(resetPasswordSchema),
  async (req, res, next) => {
    try {
      await authService.resetPassword(req.body);
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/password/change', authenticate, validate(changePasswordSchema), async (req, res, next) => {
  try {
    await authService.changePassword(req.userId!, req.body);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/oauth/google', async (req, res, next) => {
  try {
    const state = await oauthService.createOAuthState();
    res.redirect(oauthService.googleAuthorizationUrl(state));
  } catch (err) {
    next(err);
  }
});

router.get('/oauth/google/callback', async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    if (!code || !state || !(await oauthService.consumeOAuthState(state))) {
      return res.redirect(`${env.APP_URL}/login?error=oauth`);
    }
    const result = await oauthService.googleCallback(code, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setRefreshCookie(res, result.refreshToken);
    // В URL отдаём только одноразовый код обмена, сам access-токен
    // фронт заберёт через POST /api/auth/oauth/exchange.
    const loginCode = await oauthService.createLoginCode(result.accessToken);
    res.redirect(`${env.APP_URL}/oauth/success?code=${encodeURIComponent(loginCode)}`);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/oauth/exchange',
  ipRateLimit('auth:oauth-exchange', 60_000, 10),
  validate(oauthExchangeSchema),
  async (req, res, next) => {
    try {
      const accessToken = await oauthService.consumeLoginCode(req.body.code);
      if (!accessToken) {
        throw new AppError(errorCodes.UNAUTHORIZED, 'Код обмена недействителен или истёк', 401);
      }
      res.json({ data: { accessToken } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
