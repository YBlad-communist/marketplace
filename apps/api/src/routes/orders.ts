import { Router } from 'express';
import { prisma } from '@marketplace/db';
import { createOrderSchema, sellerYookassaConnectSchema, AppError, errorCodes } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import {
  createEscrowOrder,
  ensureSellerYookassa,
  releaseOrder,
  refundOrder,
} from '../services/paymentService.js';

const router: Router = Router();

router.post('/', authenticate, validate(createOrderSchema), async (req, res, next) => {
  try {
    const { confirmationToken, order } = await createEscrowOrder({
      listingId: req.body.listingId,
      buyerId: req.userId!,
      idempotencyKey: req.body.idempotencyKey,
    });
    res.status(201).json({
      data: {
        order: {
          id: order.id,
          status: order.status,
          amount: Number(order.amount),
          currency: order.currency,
        },
        confirmationToken,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', authenticate, async (req, res, next) => {
  try {
    const buyerOrders = await prisma.order.findMany({
      where: { buyerId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { listing: { include: { images: { take: 1, orderBy: { position: 'asc' as const } }, seller: { select: { id: true, name: true } } } } },
    });
    const sellerListings = await prisma.listing.findMany({
      where: { sellerId: req.userId },
      select: { id: true },
    });
    const sellerListingIds = sellerListings.map((l) => l.id);
    const sellerOrders = await prisma.order.findMany({
      where: { listingId: { in: sellerListingIds } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { listing: { include: { images: { take: 1, orderBy: { position: 'asc' as const } } } }, buyer: { select: { id: true, name: true } } },
    });

    // Для RELEASED-заказов проверяем, оставил ли текущий пользователь отзыв —
    // фронт не должен показывать кнопку "Оставить отзыв" там, где отзыв уже есть
    // (иначе упрёмся в 409 от unique-констрейнта без объяснения пользователю).
    const releasedIds = [...buyerOrders, ...sellerOrders]
      .filter((o) => o.status === 'RELEASED')
      .map((o) => o.id);
    const myReviews = releasedIds.length
      ? await prisma.review.findMany({
          where: { authorId: req.userId!, orderId: { in: releasedIds } },
          select: { orderId: true },
        })
      : [];
    const reviewedSet = new Set(myReviews.map((r) => r.orderId));

    res.json({
      data: {
        buyerOrders: buyerOrders.map((o) => ({ ...o, amount: Number(o.amount), reviewedByMe: reviewedSet.has(o.id) })),
        sellerOrders: sellerOrders.map((o) => ({ ...o, amount: Number(o.amount), reviewedByMe: reviewedSet.has(o.id) })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        listing: {
          include: {
            images: { orderBy: { position: 'asc' as const } },
            seller: { select: { id: true, name: true, avatarUrl: true, city: true, rating: true } },
          },
        },
        buyer: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
    const isBuyer = order.buyerId === req.userId;
    const isSeller = order.listing.sellerId === req.userId;
    const isStaff = req.userRole === 'ADMIN' || req.userRole === 'MODERATOR';
    if (!isBuyer && !isSeller && !isStaff) {
      throw new AppError(errorCodes.FORBIDDEN, 'Нет доступа к заказу', 403);
    }
    const reviewed = order.status === 'RELEASED'
      ? await prisma.review.findFirst({ where: { authorId: req.userId!, orderId: order.id } })
      : null;
    res.json({ data: { order: { ...order, amount: Number(order.amount), reviewedByMe: Boolean(reviewed) } } });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/release', authenticate, async (req, res, next) => {
  try {
    await releaseOrder(req.params.id, req.userId!);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/refund', authenticate, async (req, res, next) => {
  try {
    await refundOrder(req.params.id, req.userId!, req.userRole!);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/seller/connect', authenticate, validate(sellerYookassaConnectSchema), async (req, res, next) => {
  try {
    const result = await ensureSellerYookassa(req.userId!, req.body.shopId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/seller/status', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { yookassaShopId: true, yookassaOnboarded: true },
    });
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
});

export default router;
