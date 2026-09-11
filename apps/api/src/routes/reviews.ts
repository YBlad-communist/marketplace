import { Router } from 'express';
import { prisma } from '@marketplace/db';
import { reviewCreateSchema, reviewQuerySchema, AppError, errorCodes } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';

const router: Router = Router();

router.post('/', authenticate, validate(reviewCreateSchema), async (req, res, next) => {
  try {
    const { revieweeId, orderId, rating, text } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { listing: { select: { sellerId: true } } },
    });
    if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
    const isBuyer = order.buyerId === req.userId;
    const isSeller = order.listing.sellerId === req.userId;
    if (!isBuyer && !isSeller) {
      throw new AppError(errorCodes.FORBIDDEN, 'Отзыв можно оставить только по своей сделке', 403);
    }
    if (order.status !== 'RELEASED' && order.status !== 'REFUNDED') {
      throw new AppError(errorCodes.CONFLICT, 'Отзыв доступен после завершения сделки', 409);
    }
    // Контрагента берём из заказа, а не из тела запроса: иначе один заказ
    // позволял бы лепить отзывы любым пользователям платформы.
    const counterpartyId = isBuyer ? order.listing.sellerId : order.buyerId;
    if (revieweeId !== counterpartyId) {
      throw new AppError(errorCodes.VALIDATION, 'Отзыв можно оставить только контрагенту по сделке', 400);
    }

    const review = await prisma.review.create({
      data: { authorId: req.userId!, revieweeId: counterpartyId, orderId, rating, text },
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
