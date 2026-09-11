import { Router } from 'express';
import { prisma } from '@marketplace/db';
import { usersMeUpdateSchema, AppError, errorCodes } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { publicUser } from '../services/authService.js';

const router: Router = Router();

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
    res.json({ data: { user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

router.patch('/me', authenticate, validate(usersMeUpdateSchema), async (req, res, next) => {
  try {
    const { phone, ...rest } = req.body;
    if (phone !== undefined && phone !== '') {
      const exists = await prisma.user.findFirst({
        where: { phone, id: { not: req.userId } },
      });
      if (exists) {
        return next(new AppError(errorCodes.CONFLICT, 'Этот телефон уже занят', 409));
      }
    }
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { ...rest, phone: phone === '' ? null : phone === undefined ? undefined : phone },
    });
    res.json({ data: { user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        city: true,
        rating: true,
        ratingCount: true,
        isVerified: true,
        createdAt: true,
      },
    });
    if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
    res.json({ data: { user } });
  } catch (err) {
    next(err);
  }
});

export default router;
