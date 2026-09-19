import { prisma } from '@marketplace/db';
import { releaseCaptureIdempotencyKey } from '@marketplace/shared';
import { env } from './config.js';
import { logger, sendEmail } from './mailer.js';
import {
  captureYookassaPayment,
  configureYookassa,
  getYookassaPayment,
  yookassaConfigured,
} from './lib/yookassa.js';

configureYookassa(env.YOOKASSA_SHOP_ID, env.YOOKASSA_SECRET_KEY);

/**
 * Решение по статусу платежа ЮKassa для застрявшего в RELEASING заказа.
 * - 'finish' — деньги доступны (succeeded или waiting_for_capture): доводим
 *              выплату повторным capture (идемпотентно, тот же ключ, что и API);
 * - 'refund' — платёж мёртв (canceled): переводим заказ в REFUNDED и снимаем
 *              резерв с объявления (деньги уже вернулись покупателю или не были списаны);
 * - 'skip'   — непонятное состояние, не трогаем, только лог.
 */
export function decideReleasingOutcome(status: string): 'finish' | 'refund' | 'skip' {
  if (status === 'succeeded' || status === 'waiting_for_capture') return 'finish';
  if (status === 'canceled') return 'refund';
  return 'skip';
}

/**
 * Recovery-джоба: заказы, застрявшие в RELEASING (процесс упал между capture
 * и финальной транзакцией). Сверяемся с ЮKassa и доводим заказ до конца.
 *
 * Идемпотентность строится на том же, что и releaseOrder:
 * - capture идёт с тем же ключом (release-capture-{id}) — повторный прогон не
 *   создаст второго списания;
 * - финальный переход RELEASING -> RELEASED гейтится по статусу, поэтому
 *   повторный запуск джобы (ретрай BullMQ) не «захватывает» уже доведённые
 *   заказы заново.
 */
export async function recoverStuckReleasingOrders(): Promise<{
  checked: number;
  finished: number;
  refunded: number;
}> {
  if (!yookassaConfigured()) {
    logger.warn('YOOKASSA_SECRET_KEY is not configured, skipping releasing recovery');
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
      yookassaPaymentId: true,
      idempotencyKey: true,
      buyer: { select: { email: true } },
      listing: { select: { seller: { select: { email: true } } } },
    },
  });

  let finished = 0;
  let refunded = 0;
  for (const order of stale) {
    if (!order.yookassaPaymentId) continue;

    let status: string;
    try {
      const payment = await getYookassaPayment(order.yookassaPaymentId);
      status = payment.status;
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'releasing recovery: payment lookup failed, skipping');
      continue;
    }

    const outcome = decideReleasingOutcome(status);
    if (outcome === 'skip') {
      logger.warn({ orderId: order.id, status }, 'releasing recovery: unexpected payment status');
      continue;
    }

    if (outcome === 'finish') {
      try {
        await finishReleasingOrder(order);
        finished += 1;
      } catch (err) {
        logger.warn({ err, orderId: order.id, status }, 'releasing recovery: release failed, will retry');
      }
    } else {
      // Платёж отменён: средства уже вернулись покупателю (или не списаны).
      const claimed = await prisma.order.updateMany({
        where: { id: order.id, status: 'RELEASING' },
        data: { status: 'REFUNDED' },
      });
      if (claimed.count === 0) {
        logger.info({ orderId: order.id }, 'releasing recovery: order left RELEASING before update, skipping');
        continue;
      }
      await prisma.listing.updateMany({
        where: { id: order.listingId, status: 'RESERVED' },
        data: { status: 'ACTIVE' },
      });
      refunded += 1;
      logger.warn({ orderId: order.id, status }, 'releasing recovery: payment dead, order refunded');
      if (order.buyer?.email) {
        await sendEmail({
          to: order.buyer.email,
          subject: 'Платёж по заказу не прошёл, средства не списаны',
          template: 'order-updated',
          templateData: { orderId: order.id },
          text: 'Выплата по вашему заказу не удалась: платёж был отменён. Резерв с объявления снят.',
        }).catch((err) => logger.warn({ err, orderId: order.id }, 'releasing recovery email failed'));
      }
    }
  }

  return { checked: stale.length, finished, refunded };
}

/**
 * Доводим выплату RELEASING-заказа. Тот же шаг, что и в
 * performRelease (apps/api): capture сплит-платежа + транзакция RELEASING->RELEASED.
 * Распределение по transfers было задано при создании платежа, поэтому тело
 * capture пустое; повторный capture с тем же ключом идемпотентен.
 */
async function finishReleasingOrder(order: {
  id: string;
  listingId: string;
  amount: unknown;
  currency: string;
  yookassaPaymentId: string | null;
  idempotencyKey: string | null;
  buyer?: { email: string | null } | null;
  listing?: { seller?: { email: string | null } | null } | null;
}): Promise<void> {
  if (!order.yookassaPaymentId) throw new Error('no yookassa payment');

  const payment = await captureYookassaPayment(
    order.yookassaPaymentId,
    releaseCaptureIdempotencyKey(order.id)
  );
  if (payment.status !== 'succeeded') {
    throw new Error(`capture not succeeded: ${payment.status}`);
  }

  const fee = Number(((Number(order.amount) * env.YOOKASSA_PLATFORM_FEE_BASIS_POINTS) / 10000).toFixed(2));

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: { id: order.id, status: 'RELEASING' },
      data: {
        status: 'RELEASED',
        platformFee: fee,
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
    logger.info({ orderId: order.id, paymentId: order.yookassaPaymentId }, 'stuck releasing order finished by recovery');
    const sellerEmail = order.listing?.seller?.email;
    if (sellerEmail) {
      await sendEmail({
        to: sellerEmail,
        subject: 'Заказ подтверждён и выплата отправлена',
        template: 'order-updated',
        templateData: { orderId: order.id, amount: String(order.amount) },
        text: 'Покупатель подтвердил получение. Средства переведены на ваш счёт ЮKassa.',
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'releasing recovery email failed'));
    }
  }
}