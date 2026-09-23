import { Router } from 'express';
import { prisma } from '@marketplace/db';
import { reviewCreateSchema, reviewQuerySchema, AppError, errorCodes } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { env } from '../config.js';

const router: Router = Router();

router.post('/', authenticate, validate(reviewCreateSchema), async (req, res, next) => {
  try {
    const { revieweeId, orderId, rating, text } = req.body;

    // Свободный отзыв с профиля продавца (без сделки): дедуп — один отзыв
    // без orderId на пару (author, reviewee), т.к. NULL-уникальность в PG не работает.
    if (!orderId) {
      if (revieweeId === req.userId) {
        throw new AppError(errorCodes.VALIDATION, 'Нельзя оставить отзыв самому себе', 400);
      }
      const reviewee = await prisma.user.findUnique({ where: { id: revieweeId }, select: { id: true } });
      if (!reviewee) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
      const existing = await prisma.review.findFirst({
        where: { authorId: req.userId!, revieweeId, orderId: null },
        select: { id: true },
      });
      if (existing) {
        throw new AppError(errorCodes.CONFLICT, 'Вы уже оставили отзыв этому пользователю', 409);
      }
      const review = await prisma.$transaction(async (tx) => {
        const created = await tx.review.create({
          data: { authorId: req.userId!, revieweeId, orderId: null, rating, text },
        });
        const agg = await tx.review.aggregate({
          where: { revieweeId },
          _avg: { rating: true },
          _count: true,
        });
        await tx.user.update({
          where: { id: revieweeId },
          data: { rating: agg._avg.rating ?? 0, ratingCount: agg._count },
        });
        return created;
      });
      res.status(201).json({ data: { review } });
      return;
    }

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
    // Отзыв пишется только после фактически завершённой сделки (RELEASED):
    // REFUNDED/возврат означает, что товар покупателю не передан, и его оценка
    // лишь засоряет рейтинг. Оценка «взаимной» рекламы с копеечными сделками
    // тоже отсекается минимальной суммой заказа (порог из env — меняется без
    // пересборки API).
    if (order.status !== 'RELEASED') {
      throw new AppError(errorCodes.CONFLICT, 'Отзыв доступен только после успешно завершённой сделки', 409);
    }
    if (order.amount.toNumber() < env.REVIEW_MIN_ORDER_TOTAL) {
      throw new AppError(errorCodes.VALIDATION, 'Сумма заказа слишком мала для отзыва', 400);
    }
    // Контрагента берём из заказа, а не из тела запроса: иначе один заказ
    // позволял бы лепить отзывы любым пользователям платформы.
    const counterpartyId = isBuyer ? order.listing.sellerId : order.buyerId;
    if (revieweeId !== counterpartyId) {
      throw new AppError(errorCodes.VALIDATION, 'Отзыв можно оставить только контрагенту по сделке', 400);
    }

    // Анти-накрутка: не больше REVIEW_PAIR_LIMIT отзывов между одной парой
    // за REVIEW_PAIR_WINDOW_DAYS дней (взаимные «обмены рейтингом» гаснут).
    const pairCutoff = new Date(Date.now() - env.REVIEW_PAIR_WINDOW_DAYS * 86_400_000);
    const pairCount = await prisma.review.count({
      where: {
        authorId: req.userId!,
        revieweeId: counterpartyId,
        createdAt: { gte: pairCutoff },
      },
    });
    if (pairCount >= env.REVIEW_PAIR_LIMIT) {
      throw new AppError(errorCodes.CONFLICT, 'Вы уже оставили отзыв этому пользователю в текущем периоде', 409);
    }

    // Создание + пересчёт рейтинга атомарны: агрегат видит только что
    // созданный отзыв, и между create и aggregate никто не «пролез»
    // с конкурентным отзывом (иначе рейтинг разъезжался с реальностью).
    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: { authorId: req.userId!, revieweeId: counterpartyId, orderId, rating, text },
      });
      const agg = await tx.review.aggregate({
        where: { revieweeId: counterpartyId },
        _avg: { rating: true },
        _count: true,
      });
      await tx.user.update({
        where: { id: counterpartyId },
        data: { rating: agg._avg.rating ?? 0, ratingCount: agg._count },
      });
      return created;
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
