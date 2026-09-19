import Stripe from 'stripe';
import { prisma } from '@marketplace/db';
import { releaseCaptureIdempotencyKey, releaseTransferIdempotencyKey } from '@marketplace/shared';
import { env } from './config.js';
import { logger, sendEmail } from './mailer.js';

let stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!stripe) {
    stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return stripe;
}

/**
 * Решение по статусу PaymentIntent для застрявшего в RELEASING заказа.
 * - 'finish' — деньги доступны (succeeded или requires_capture): доводим выплату;
 * - 'refund'  — платёж мёртв (canceled/requires_payment_method/failed/processing):
 *               переводим заказ в REFUNDED и снимаем резерв с объявления;
 * - 'skip'    — непонятное состояние, не трогаем, только лог.
 */
export function decideReleasingOutcome(piStatus: string): 'finish' | 'refund' | 'skip' {
  if (piStatus === 'succeeded' || piStatus === 'requires_capture') return 'finish';
  if (piStatus === 'canceled' || piStatus === 'requires_payment_method' || piStatus === 'failed') {
    return 'refund';
  }
  return 'skip';
}

/**
 * Recovery-джоба: заказы, застрявшие в RELEASING (процесс упал между capture
 * и финальной транзакцией). Сверяемся со Stripe и доводим заказ до конца.
 *
 * Идемпотентность строится на том же, что и releaseOrder:
 * - capture/transfer идут с теми же idempotency-ключами (release-capture-{id},
 *   release-{id}) — повторный прогон не создаст второго перевода;
 * - финальный переход RELEASING -> RELEASED гейтится по статусу, поэтому
 *   повторный запуск джобы (ретрай BullMQ) не «захватывает» уже доведённые
 *   заказы заново.
 */
export async function recoverStuckReleasingOrders(): Promise<{
  checked: number;
  finished: number;
  refunded: number;
}> {
  const s = getStripe();
  if (!s) {
    logger.warn('STRIPE_SECRET_KEY is not configured, skipping releasing recovery');
    return { checked: 0, finished: 0, refunded: 0 };
  }

  const cutoff = new Date(Date.now() - Math.max(60_000, env.RELEASING_RECOVERY_AFTER_MS));
  const stale = await prisma.order.findMany({
    where: { status: 'RELEASING', updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: 100,
    select: {
      id: true,
      listingId: true,
      amount: true,
      currency: true,
      stripePaymentIntentId: true,
      idempotencyKey: true,
      buyer: { select: { email: true } },
      listing: { select: { seller: { select: { email: true, stripeAccountId: true } } } },
    },
  });

  let finished = 0;
  let refunded = 0;
  for (const order of stale) {
    if (!order.stripePaymentIntentId || !order.listing?.seller.stripeAccountId) continue;

    let piStatus: string;
    try {
      const pi = await s.paymentIntents.retrieve(order.stripePaymentIntentId);
      piStatus = pi.status;
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'releasing recovery: payment intent lookup failed, skipping');
      continue;
    }

    const outcome = decideReleasingOutcome(piStatus);
    if (outcome === 'skip') {
      logger.warn({ orderId: order.id, piStatus }, 'releasing recovery: unexpected payment intent status');
      continue;
    }

    if (outcome === 'finish') {
      try {
        await finishReleasingOrder(order, s);
        finished += 1;
      } catch (err) {
        logger.warn({ err, orderId: order.id, piStatus }, 'releasing recovery: release failed, will retry');
      }
    } else {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'REFUNDED' },
      });
      await prisma.listing.updateMany({
        where: { id: order.listingId, status: 'RESERVED' },
        data: { status: 'ACTIVE' },
      });
      refunded += 1;
      logger.warn({ orderId: order.id, piStatus }, 'releasing recovery: payment dead, order refunded');
      if (order.buyer.email) {
        await sendEmail({
          to: order.buyer.email,
          subject: 'Платёж по заказу не прошёл, средства не списаны',
          template: 'order-updated',
          templateData: { orderId: order.id },
          text: 'Выплата по вашему заказу не удалась: платёж был отклонён. Резерв с объявления снят.',
        }).catch((err) => logger.warn({ err, orderId: order.id }, 'releasing recovery email failed'));
      }
    }
  }

  return { checked: stale.length, finished, refunded };
}

/**
 * Доводим выплату RELEASING-заказа. Тот же набор шагов, что и в
 * performRelease (apps/api): capture + transfer + транзакция RELEASING->RELEASED.
 */
async function finishReleasingOrder(
  order: {
    id: string;
    listingId: string;
    amount: unknown;
    currency: string;
    stripePaymentIntentId: string | null;
    idempotencyKey: string | null;
  },
  s: Stripe
): Promise<void> {
  if (!order.stripePaymentIntentId) throw new Error('no payment intent');

  const pi = await s.paymentIntents.capture(order.stripePaymentIntentId, {
    idempotencyKey: releaseCaptureIdempotencyKey(order.id),
  });
  if (pi.status !== 'succeeded') {
    throw new Error(`capture not succeeded: ${pi.status}`);
  }

  const fee = Math.round((Number(order.amount) * env.STRIPE_PLATFORM_FEE_BASIS_POINTS) / 10000 * 100);
  const full = await prisma.order.findUnique({
    where: { id: order.id },
    select: { listing: { select: { seller: { select: { email: true, stripeAccountId: true } } } } },
  });
  const destination = full?.listing?.seller?.stripeAccountId;
  if (!destination) throw new Error('seller stripe account missing');

  const transfer = await s.transfers.create(
    {
      amount: Math.round(Number(order.amount) * 100) - fee,
      currency: order.currency.toLowerCase(),
      destination,
      transfer_group: `order-${order.idempotencyKey?.slice(0, 24)}`,
    },
    { idempotencyKey: releaseTransferIdempotencyKey(order.id) }
  );

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: { id: order.id, status: 'RELEASING' },
      data: {
        status: 'RELEASED',
        stripeTransferId: transfer.id,
        platformFee: fee / 100,
        releasedAt: new Date(),
      },
    });
    if (res.count !== 1) return false;
    await tx.listing.updateMany({
      where: { id: order.listingId, status: 'RESERVED' },
      data: { status: 'SOLD' },
    });
    return true;
  });

  if (updated) {
    logger.info({ orderId: order.id, transferId: transfer.id }, 'stuck releasing order finished by recovery');
    const sellerEmail = full?.listing?.seller?.email;
    if (sellerEmail) {
      await sendEmail({
        to: sellerEmail,
        subject: 'Заказ подтверждён и выплата отправлена',
        template: 'order-updated',
        templateData: { orderId: order.id, amount: String(order.amount) },
        text: 'Покупатель подтвердил получение. Средства переведены на ваш счёт Stripe.',
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'releasing recovery email failed'));
    }
  }
}