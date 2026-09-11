import Stripe from 'stripe';
import { Order, prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { enqueueEmail } from './notificationService.js';

/**
 * ЭСКРОУ-ПАТТЕРН: PaymentIntent с manual capture.
 * 1. Покупатель платит -> деньги авторизованы и УДЕРЖАНЫ платформой (не списаны).
 * 2. Покупатель подтверждает получение -> сервер делает capture + transfer продавцу.
 * 3. Возврат/спор -> refund до capture.
 * Это самая простая и безопасная модель эскроу без создания произвольных сущностей Stripe.
 */

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new AppError(errorCodes.INTERNAL, 'Stripe не настроен', 500);
    }
    stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return stripe;
}

export function platformFeeBasisPoints(): number {
  return env.STRIPE_PLATFORM_FEE_BASIS_POINTS;
}

export async function ensureSellerStripeAccount(sellerId: string): Promise<{ accountId: string; url: string | null }> {
  const s = getStripe();
  const seller = await prisma.user.findUnique({ where: { id: sellerId } });
  if (!seller) throw new AppError(errorCodes.NOT_FOUND, 'Продавец не найден', 404);

  let accountId = seller.stripeAccountId;
  if (!accountId) {
    const account = await s.accounts.create({ type: 'express' });
    accountId = account.id;
    await prisma.user.update({ where: { id: sellerId }, data: { stripeAccountId: accountId } });
  }

  const accountLink = await s.accountLinks.create({
    account: accountId,
    refresh_url: env.STRIPE_CONNECT_ONBOARDING_URL,
    return_url: env.STRIPE_CONNECT_ONBOARDING_URL,
    type: 'account_onboarding',
  });
  return { accountId, url: accountLink.url };
}

export async function createEscrowOrder(input: {
  listingId: string;
  buyerId: string;
  idempotencyKey: string;
}): Promise<{ order: Order; clientSecret: string }> {
  const s = getStripe();

  // Сначала проверяем идемпотентность — повторный запрос с тем же ключом
  // должен вернуть существующий заказ, а не создавать дубликат.
  const existingOrder = await prisma.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existingOrder) {
    if (existingOrder.listingId !== input.listingId) {
      throw new AppError(errorCodes.CONFLICT, 'Idempotency-ключ уже использован', 409);
    }
    if (existingOrder.stripePaymentIntentId) {
      const pi = await s.paymentIntents.retrieve(existingOrder.stripePaymentIntentId);
      return { order: existingOrder, clientSecret: pi.client_secret ?? '' };
    }
    throw new AppError(errorCodes.CONFLICT, 'Заказ уже существует', 409);
  }

  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    include: { order: true, seller: { select: { stripeAccountId: true, stripeOnboarded: true, id: true } } },
  });
  if (!listing) throw new AppError(errorCodes.NOT_FOUND, 'Объявление не найдено', 404);
  if (listing.sellerId === input.buyerId) {
    throw new AppError(errorCodes.VALIDATION, 'Нельзя купить собственное объявление', 400);
  }
  if (listing.order) {
    throw new AppError(errorCodes.CONFLICT, 'По этому объявлению уже есть заказ', 409);
  }
  if (listing.status !== 'ACTIVE') {
    throw new AppError(errorCodes.CONFLICT, 'Объявление недоступно для покупки', 409);
  }
  if (!listing.seller.stripeAccountId || !listing.seller.stripeOnboarded) {
    throw new AppError(
      errorCodes.PAYMENT_REQUIRED,
      'Продавец ещё не подключил выплаты. Свяжитесь с продавцом.',
      402
    );
  }

  const amount = Math.round(Number(listing.price) * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError(errorCodes.VALIDATION, 'Некорректная цена', 400);
  }

  const paymentIntent = await s.paymentIntents.create(
    {
      amount,
      currency: listing.currency.toLowerCase(),
      capture_method: 'manual',
      transfer_group: `order-${input.idempotencyKey.slice(0, 24)}`,
      metadata: { orderKey: input.idempotencyKey, listingId: listing.id, buyerId: input.buyerId },
    },
    { idempotencyKey: input.idempotencyKey }
  );

  const order = await prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId: input.buyerId,
      amount: listing.price,
      currency: listing.currency,
      stripePaymentIntentId: paymentIntent.id,
      idempotencyKey: input.idempotencyKey,
    },
  }).catch((err: unknown) => {
    // Гонка двух параллельных POST /orders: второй получает 409, а не 500.
    if (
      typeof err === 'object' && err !== null &&
      'code' in err && (err as { code?: string }).code === 'P2002'
    ) {
      throw new AppError(errorCodes.CONFLICT, 'По этому объявлению уже есть заказ', 409);
    }
    throw err;
  });

  return { order, clientSecret: paymentIntent.client_secret ?? '' };
}

export async function releaseOrder(orderId: string, actorId: string): Promise<void> {
  const s = getStripe();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { seller: true } } },
  });
  if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
  if (order.buyerId !== actorId) {
    throw new AppError(errorCodes.FORBIDDEN, 'Подтвердить получение может только покупатель', 403);
  }
  // Эскроу: release только после авторизации средств (PAID = requires_capture).
  // PENDING означает, что деньги ещё не удержаны — capture упадёт в Stripe.
  if (order.status !== 'PAID') {
    throw new AppError(errorCodes.CONFLICT, `Нельзя подтвердить заказ в статусе ${order.status}`, 409);
  }
  if (!order.stripePaymentIntentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  const pi = await s.paymentIntents.capture(order.stripePaymentIntentId);
  if (pi.status !== 'succeeded') {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не может быть завершён', 409);
  }

  const fee = Math.round((Number(order.amount) * env.STRIPE_PLATFORM_FEE_BASIS_POINTS) / 10000 * 100);
  const transfer = await s.transfers.create({
    amount: Math.round(Number(order.amount) * 100) - fee,
    currency: order.currency.toLowerCase(),
    destination: order.listing.seller.stripeAccountId!,
    transfer_group: `order-${order.idempotencyKey?.slice(0, 24)}`,
  });

  await prisma.$transaction([
    prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'RELEASED',
        stripeTransferId: transfer.id,
        platformFee: fee / 100,
        releasedAt: new Date(),
      },
    }),
    prisma.listing.update({
      where: { id: order.listingId },
      data: { status: 'SOLD' },
    }),
  ]);

  const sellerEmail = order.listing.seller.email;
  if (sellerEmail) {
    await enqueueEmail({
      to: sellerEmail,
      subject: 'Заказ подтверждён и выплата отправлена',
      template: 'order-updated',
      templateData: { orderId: order.id, amount: String(order.amount) },
      text: `Покупатель подтвердил получение. Средства переведены на ваш счёт Stripe.`,
    });
  }
}

export async function refundOrder(orderId: string, actorId: string, role: string): Promise<void> {
  const s = getStripe();
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
  const isBuyer = order.buyerId === actorId;
  const isStaff = role === 'ADMIN' || role === 'MODERATOR';
  if (!isBuyer && !isStaff) {
    throw new AppError(errorCodes.FORBIDDEN, 'Нет прав на возврат', 403);
  }
  if (order.status === 'RELEASED' || order.status === 'REFUNDED') {
    throw new AppError(errorCodes.CONFLICT, `Нельзя вернуть заказ в статусе ${order.status}`, 409);
  }
  if (!order.stripePaymentIntentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  const pi = await s.paymentIntents.retrieve(order.stripePaymentIntentId);
  if (pi.status !== 'requires_capture' && pi.status !== 'succeeded') {
    throw new AppError(errorCodes.CONFLICT, 'Платёж в неподходящем статусе', 409);
  }
  await s.paymentIntents.cancel(order.stripePaymentIntentId).catch(() => {
    return s.refunds.create({ payment_intent: order.stripePaymentIntentId! });
  });

  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'REFUNDED' },
  });
}

/** Вебхук Stripe: проверка подписи + идемпотентная обработка */
export async function handleStripeWebhook(
  rawBody: Buffer,
  signature: string | undefined
): Promise<{ received: boolean; handled?: string }> {
  const s = getStripe();
  if (!env.STRIPE_WEBHOOK_SECRET || !signature) {
    throw new AppError(errorCodes.UNAUTHORIZED, 'Нет подписи вебхука', 401);
  }
  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn({ err }, 'stripe webhook signature invalid');
    throw new AppError(errorCodes.UNAUTHORIZED, 'Неверная подпись вебхука', 401);
  }

  const redis = getRedis();
  const dedupe = await redis.set(`stripe:webhook:${event.id}`, '1', 'EX', 86400, 'NX');
  if (dedupe !== 'OK') {
    return { received: true, handled: 'duplicate' };
  }

  switch (event.type) {
    case 'payment_intent.created': {
      // Только создан — деньги ещё не авторизованы. Ничего не меняем.
      break;
    }
    case 'payment_intent.amount_capturable_updated': {
      // Эскроу: средства авторизованы (requires_capture) и удерживаются платформой.
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderKey = pi.metadata?.orderKey;
      if (orderKey) {
        await prisma.order.updateMany({
          where: { idempotencyKey: orderKey, status: 'PENDING' },
          data: { status: 'PAID' },
        });
      }
      break;
    }
    case 'payment_intent.succeeded': {
      // Succeeded наступает ПОСЛЕ capture в releaseOrder.
      // releaseOrder уже перевёл заказ в RELEASED+SOLD в той же транзакции,
      // поэтому вебхук только доводит PENDING/PAID-заказы до PAID и
      // никогда не делает авто-RELEASE без подтверждения покупателя.
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderKey = pi.metadata?.orderKey;
      if (orderKey) {
        const existing = await prisma.order.findUnique({
          where: { idempotencyKey: orderKey },
          select: { id: true, status: true },
        });
        if (existing && (existing.status === 'PENDING' || existing.status === 'PAID')) {
          // Если capture делал releaseOrder — заказ уже RELEASED, сюда не попадём.
          // Если Stripe в automatic-режиме — фиксируем оплату, но не выдаём товар.
          await prisma.order.update({
            where: { id: existing.id },
            data: { status: 'PAID' },
          });
          logger.info({ orderKey, pi: pi.id }, 'escrow authorized, awaiting buyer confirmation');
        }
      }
      break;
    }
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      // Оплата не состоялась — удаляем PENDING-заказ, чтобы не блокировать
      // повторную покупку (createEscrowOrder запрещает второй заказ на листинг).
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderKey = pi.metadata?.orderKey;
      if (orderKey) {
        await prisma.order.deleteMany({
          where: { idempotencyKey: orderKey, status: 'PENDING' },
        });
      }
      break;
    }
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      await prisma.user.updateMany({
        where: { stripeAccountId: account.id },
        data: { stripeOnboarded: account.details_submitted ?? false },
      });
      break;
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      if (charge.payment_intent && typeof charge.payment_intent === 'string') {
        await prisma.order.updateMany({
          where: { stripePaymentIntentId: charge.payment_intent },
          data: { status: 'REFUNDED' },
        });
      }
      break;
    }
    default:
      break;
  }
  return { received: true, handled: event.type };
}

export async function createStripeConnectAccount(sellerId: string): Promise<{ accountId: string }> {
  const s = getStripe();
  const account = await s.accounts.create({ type: 'express' });
  await prisma.user.update({ where: { id: sellerId }, data: { stripeAccountId: account.id } });
  return { accountId: account.id };
}
