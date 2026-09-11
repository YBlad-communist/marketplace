import { Router } from 'express';
import { prisma } from '@marketplace/db';
import { createOrderSchema, AppError, errorCodes } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import {
  createEscrowOrder,
  ensureSellerStripeAccount,
  releaseOrder,
  refundOrder,
} from '../services/paymentService.js';

const router: Router = Router();

router.post('/', authenticate, validate(createOrderSchema), async (req, res, next) => {
  try {
    const { clientSecret, order } = await createEscrowOrder({
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
        clientSecret,
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
    res.json({
      data: {
        buyerOrders: buyerOrders.map((o) => ({ ...o, amount: Number(o.amount) })),
        sellerOrders: sellerOrders.map((o) => ({ ...o, amount: Number(o.amount) })),
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
    res.json({ data: { order: { ...order, amount: Number(order.amount) } } });
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

router.post('/seller/connect', authenticate, async (req, res, next) => {
  try {
    const result = await ensureSellerStripeAccount(req.userId!);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/seller/status', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { stripeAccountId: true, stripeOnboarded: true },
    });
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
});

export default router;
