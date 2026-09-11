import Stripe from 'stripe';
import { prisma } from '@marketplace/db';
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
 * Решение по статусу PaymentIntent для зависшего PAID-заказа.
 * - 'held' — холд жив (requires_capture), заказ ждёт покупателя;
 * - 'expired' — холд мёртв, деньги у Stripe освобождены, заказ надо закрывать;
 * - 'unknown' — непонятное состояние, не трогаем, только лог.
 */
export function decideHoldOutcome(piStatus: string): 'held' | 'expired' | 'unknown' {
  if (piStatus === 'requires_capture') return 'held';
  if (piStatus === 'canceled' || piStatus === 'requires_payment_method') return 'expired';
  return 'unknown';
}

/**
 * Периодическая чистка зависших эскроу-холдов.
 * Stripe сам отменяет manual-capture авторизацию (~7 дней), а заказ в БД
 * навсегда остался бы PAID с залоченным объявлением. Находим такие заказы,
 * сверяемся со Stripe и переводим в REFUNDED + снимаем резерв.
 */
export async function checkExpiredHoldsJob(): Promise<{ checked: number; refunded: number }> {
  const s = getStripe();
  if (!s) {
    logger.warn('STRIPE_SECRET_KEY is not configured, skipping expired holds check');
    return { checked: 0, refunded: 0 };
  }

  const ttlMs = Math.max(1, env.STRIPE_HOLD_TTL_DAYS) * 86400_000;
  const cutoff = new Date(Date.now() - ttlMs);

  const stale = await prisma.order.findMany({
    where: { status: 'PAID', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      listingId: true,
      stripePaymentIntentId: true,
      buyer: { select: { email: true } },
    },
  });

  let refunded = 0;
  for (const order of stale) {
    if (!order.stripePaymentIntentId) continue;
    let piStatus: string;
    try {
      const pi = await s.paymentIntents.retrieve(order.stripePaymentIntentId);
      piStatus = pi.status;
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'expired holds: payment intent lookup failed, skipping');
      continue;
    }

    const outcome = decideHoldOutcome(piStatus);
    if (outcome === 'held') continue;
    if (outcome === 'unknown') {
      logger.warn({ orderId: order.id, piStatus }, 'expired holds: unexpected payment intent status');
      continue;
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'REFUNDED' },
    });
    await prisma.listing.updateMany({
      where: { id: order.listingId, status: 'RESERVED' },
      data: { status: 'ACTIVE' },
    });
    refunded += 1;
    logger.info({ orderId: order.id, piStatus }, 'expired escrow hold refunded');

    if (order.buyer.email) {
      await sendEmail({
        to: order.buyer.email,
        subject: 'Холд по заказу истёк, оплата возвращена',
        template: 'order-updated',
        templateData: { orderId: order.id },
        text: `Срок удержания оплаты по заказу истёк, холд отменён. Если товар всё ещё нужен — оформите заказ заново.`,
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'expired hold email failed'));
    }
  }

  return { checked: stale.length, refunded };
}
