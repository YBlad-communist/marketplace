import { Router } from 'express';
import { prisma } from '@marketplace/db';
import { reportCreateSchema, AppError, errorCodes } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { logSecurityEvent } from '../lib/logger.js';

const router: Router = Router();

router.post('/', authenticate, validate(reportCreateSchema), async (req, res, next) => {
  try {
    const { targetType, targetId, reason, comment } = req.body;

    if (targetType === 'LISTING') {
      const listing = await prisma.listing.findUnique({ where: { id: targetId } });
      if (!listing) throw new AppError(errorCodes.NOT_FOUND, 'Объявление не найдено', 404);
      if (listing.sellerId === req.userId) {
        throw new AppError(errorCodes.VALIDATION, 'Нельзя пожаловаться на собственное объявление', 400);
      }
    } else if (targetType === 'USER') {
      const user = await prisma.user.findUnique({ where: { id: targetId } });
      if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
      if (user.id === req.userId) {
        throw new AppError(errorCodes.VALIDATION, 'Нельзя пожаловаться на себя', 400);
      }
    } else {
      const message = await prisma.message.findUnique({ where: { id: targetId } });
      if (!message) throw new AppError(errorCodes.NOT_FOUND, 'Сообщение не найдено', 404);
    }

    const report = await prisma.report.create({
      data: { authorId: req.userId!, targetType, targetId, reason, comment },
    });
    logSecurityEvent('report_created', { reportId: report.id, targetType, targetId });

    res.status(201).json({ data: { report } });
  } catch (err) {
    next(err);
  }
});

export default router;
