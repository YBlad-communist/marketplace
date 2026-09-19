import { Router } from 'express';
import { prisma } from '@marketplace/db';
import {
  adminModerationSchema,
  adminBanSchema,
  AppError,
  errorCodes,
} from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate, requireModerator, requireAdmin } from '../middleware/auth.js';
import { approveListing, rejectListing } from '../services/moderationService.js';
import { logSecurityEvent } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';

const router: Router = Router();

// Без authenticate req.userId/req.userRole не выставлены, и requireRole
// отдавал бы 401 каждому запросу (баг с первого коммита — админка была мертва).
router.use(authenticate);
router.use(requireModerator);

router.get('/listings/pending', async (req, res, next) => {
  try {
    const listings = await prisma.listing.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { seller: { select: { id: true, name: true } }, images: { take: 1 } },
    });
    res.json({ data: { listings: listings.map((l) => ({ ...l, price: Number(l.price) })) } });
  } catch (err) {
    next(err);
  }
});

router.post('/listings/:id/moderate', validate(adminModerationSchema), async (req, res, next) => {
  try {
    const { action, reason } = req.body;
    if (action === 'APPROVE') {
      await approveListing(req.params.id, req.userId!);
    } else {
      await rejectListing(req.params.id, req.userId!, reason);
    }
    logSecurityEvent('listing_moderated', { listingId: req.params.id, action, moderator: req.userId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/reports', async (req, res, next) => {
  try {
    const reports = await prisma.report.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { author: { select: { id: true, name: true } } },
    });
    res.json({ data: { reports } });
  } catch (err) {
    next(err);
  }
});

router.post('/reports/:id/resolve', async (req, res, next) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) throw new AppError(errorCodes.NOT_FOUND, 'Жалоба не найдена', 404);
    const action = req.body.action === 'RESOLVED' ? 'RESOLVED' : 'DISMISSED';
    await prisma.report.update({
      where: { id: report.id },
      data: { status: action, resolvedBy: req.userId },
    });
    if (action === 'RESOLVED' && report.targetType === 'LISTING') {
      await rejectListing(report.targetId, req.userId!, 'Жалоба подтверждена');
    }
    logSecurityEvent('report_resolved', { reportId: report.id, action, moderator: req.userId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.use(requireAdmin);

router.post('/users/:id/ban', validate(adminBanSchema), async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
    if (user.role === 'ADMIN') {
      throw new AppError(errorCodes.FORBIDDEN, 'Нельзя забанить администратора', 403);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isBanned: req.body.banned,
        banReason: req.body.banned ? (req.body.reason ?? 'Нарушение правил') : null,
      },
    });
    // Инвалидируем кэш авторизации и на бан, и на разбан: иначе забаненный
    // до минуты ходит по API как обычный, а разбаненный ещё минуту — как забаненный.
    const redis = getRedis();
    await redis.del(`user:auth:${user.id}`);
    if (req.body.banned) {
      await prisma.refreshTokenFamily.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    logSecurityEvent('user_banned', { userId: user.id, banned: req.body.banned, admin: req.userId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isBanned: true,
        isVerified: true,
        createdAt: true,
      },
    });
    res.json({ data: { users } });
  } catch (err) {
    next(err);
  }
});

export default router;
