import { Router } from 'express';
import { prisma } from '@marketplace/db';
import { reviewCreateSchema, reviewQuerySchema, AppError, errorCodes } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';

const router: Router = Router();

router.post('/', authenticate, validate(reviewCreateSchema), async (req, res, next) => {
  try {
    const { revieweeId, orderId, rating, text } = req.body;
    if (revieweeId === req.userId) {
      throw new AppError(errorCodes.VALIDATION, 'Нельзя оставить отзыв самому себе', 400);
    }

    if (orderId) {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { listing: { select: { sellerId: true } } },
      });
      if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
      const isParticipant = order.buyerId === req.userId || order.listing.sellerId === req.userId;
      if (!isParticipant) {
        throw new AppError(errorCodes.FORBIDDEN, 'Отзыв можно оставить только по своей сделке', 403);
      }
      if (order.status !== 'RELEASED' && order.status !== 'REFUNDED') {
        throw new AppError(errorCodes.CONFLICT, 'Отзыв доступен после завершения сделки', 409);
      }
    }

    const review = await prisma.review.create({
      data: { authorId: req.userId!, revieweeId, orderId: orderId ?? null, rating, text },
    });

    const agg = await prisma.review.aggregate({
      where: { revieweeId },
      _avg: { rating: true },
      _count: true,
    });
    await prisma.user.update({
      where: { id: revieweeId },
      data: { rating: agg._avg.rating ?? 0, ratingCount: agg._count },
    });

    res.status(201).json({ data: { review } });
  } catch (err) {
    next(err);
  }
});

router.get('/', validate(reviewQuerySchema, 'query'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    const reviews = await prisma.review.findMany({
      where: { revieweeId: String(req.query.userId) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      cursor: req.query.cursor ? { id: String(req.query.cursor) } : undefined,
      skip: req.query.cursor ? 1 : 0,
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    });
    const hasMore = reviews.length > limit;
    const items = reviews.slice(0, limit);
    res.json({
      data: {
        items,
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
