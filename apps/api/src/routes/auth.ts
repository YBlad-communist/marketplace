import { Router } from 'express';
import type { Request } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
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
import { requireCaptcha } from '../middleware/captcha.js';
import * as authService from '../services/authService.js';
import {
  findSessionFamilyByToken,
  getActiveSessions,
  revokeSessionFamily,
} from '../services/tokenService.js';
import { refreshCookieName, refreshCookieOptions, clearRefreshCookieOptions } from '../lib/cookies.js';
import { logSecurityEvent } from '../lib/logger.js';

const router: Router = Router();

function setRefreshCookie(res: { cookie: (n: string, v: string, o: object) => void }, token: string) {
  res.cookie(refreshCookieName, token, refreshCookieOptions);
}

function refreshTokenFromReq(req: Request): string | null {
  return (
    extractTokenFromCookie(req, refreshCookieName) ??
    (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null)
  );
}

router.post(
  '/register',
  ipRateLimit('auth:register', 60_000, 10),
  requireCaptcha,
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
  requireCaptcha,
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

router.post(
  '/verification/request',
  ipRateLimit('verification:request', 60_000, 5),
  authenticate,
  validate(requestVerificationSchema),
  async (req, res, next) => {
    try {
      // телефонная верификация — код отправляется через SMS.RU worker (см. apps/worker/src/smsru.ts)
      await authService.requestPhoneVerification(req.userId!);
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/verification/verify',
  ipRateLimit('verification:verify', 60_000, 10),
  authenticate,
  validate(verifyEmailSchema),
  async (req, res, next) => {
    try {
      await authService.verifyPhone(req.userId!, req.body.code);
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

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

router.get('/sessions', authenticate, async (req, res, next) => {
  try {
    const sessions = await getActiveSessions(req.userId!);
    const currentToken = refreshTokenFromReq(req);
    const currentFamilyId = currentToken ? await findSessionFamilyByToken(currentToken) : null;
    res.json({
      data: {
        items: sessions.map((s) => ({ ...s, current: s.familyId === currentFamilyId })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/sessions/:familyId', authenticate, async (req, res, next) => {
  try {
    const familyId = req.params.familyId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(familyId)) {
      throw new AppError(errorCodes.VALIDATION, 'Некорректный идентификатор сессии', 400);
    }
    const currentToken = refreshTokenFromReq(req);
    const currentFamilyId = currentToken ? await findSessionFamilyByToken(currentToken) : null;
    if (familyId === currentFamilyId) {
      throw new AppError(errorCodes.CONFLICT, 'Нельзя отозвать текущую сессию — используйте «Выйти»', 409);
    }
    const revoked = await revokeSessionFamily(req.userId!, familyId);
    if (!revoked) {
      throw new AppError(errorCodes.NOT_FOUND, 'Сессия не найдена', 404);
    }
    logSecurityEvent('session_revoked', { userId: req.userId, familyId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
