import { prisma } from '@marketplace/db';
import { expiredHoldCancelIdempotencyKey } from '@marketplace/shared';
import { env } from './config.js';
import { logger, sendEmail } from './mailer.js';
import {
  cancelYookassaPayment,
  configureYookassa,
  getYookassaPayment,
  yookassaConfigured,
} from './lib/yookassa.js';

configureYookassa(env.YOOKASSA_SHOP_ID, env.YOOKASSA_SECRET_KEY);

/**
 * Решение по статусу платежа ЮKassa для зависшего PAID-заказа.
 * - 'held'    — холд жив (waiting_for_capture), заказ ждёт покупателя;
 * - 'expired' — холд мёртв (canceled) или деньги так и не авторизованы
 *               (pending): ЮKassa рано или поздно отменит платёж сама,
 *               заказ в БД не должен вечно висеть с залоченным объявлением;
 * - 'unknown' — непонятное состояние, не трогаем, только лог.
 */
export function decideHoldOutcome(status: string): 'held' | 'expired' | 'unknown' {
  if (status === 'waiting_for_capture') return 'held';
  if (status === 'canceled' || status === 'pending') return 'expired';
  return 'unknown';
}

/**
 * Периодическая чистка зависших эскроу-холдов.
 * ЮKassa сама отменяет авторизации, не завершённые capture (~7 дней), а заказ
 * в БД навсегда остался бы PAID с залоченным объявлением. Находим такие заказы,
 * сверяемся с ЮKassa и переводим в REFUNDED + снимаем резерв.
 */
export async function checkExpiredHoldsJob(): Promise<{ checked: number; refunded: number }> {
  if (!yookassaConfigured()) {
    logger.warn('YOOKASSA_SECRET_KEY is not configured, skipping expired holds check');
    return { checked: 0, refunded: 0 };
  }

  const ttlMs = Math.max(1, env.YOOKASSA_HOLD_TTL_DAYS) * 86400_000;
  const cutoff = new Date(Date.now() - ttlMs);

  const stale = await prisma.order.findMany({
    where: { status: 'PAID', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      listingId: true,
      yookassaPaymentId: true,
      buyer: { select: { email: true } },
    },
  });

  let refunded = 0;
  for (const order of stale) {
    if (!order.yookassaPaymentId) continue;
    let status: string;
    try {
      const payment = await getYookassaPayment(order.yookassaPaymentId);
      status = payment.status;
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'expired holds: payment lookup failed, skipping');
      continue;
    }

    const outcome = decideHoldOutcome(status);
    if (outcome === 'held') continue;
    if (outcome === 'unknown') {
      logger.warn({ orderId: order.id, status }, 'expired holds: unexpected payment status');
      continue;
    }

    if (status === 'pending') {
      // Непомеченный как оплаченный платёж: понуждаем ЮKassa закрыть холд
      // (ждём её статус canceled), затем финальный клейм ниже не сработает,
      // а заказ удаляется/освобождается через следующую итерацию/вебхук.
      await cancelYookassaPayment(
        order.yookassaPaymentId,
        expiredHoldCancelIdempotencyKey(order.id)
      ).catch((err) => logger.warn({ err, orderId: order.id }, 'expired holds: cancel failed, will recheck'));
      continue;
    }

    // Атомарный клейм PAID -> REFUNDED, как в releaseOrder: между чтением списка
    // и записью покупатель мог успеть перевести заказ в RELEASING (releaseOrder).
    // Простое order.update затёрло бы начатую выплату статусом REFUNDED; updateMany
    // с условием на PAID проигрывает гонку и пропускает заказ.
    const claimed = await prisma.order.updateMany({
      where: { id: order.id, status: 'PAID' },
      data: { status: 'REFUNDED' },
    });
    if (claimed.count === 0) {
      logger.info({ orderId: order.id }, 'expired holds: order left PAID before update, skipping');
      continue;
    }
    await prisma.listing.updateMany({
      where: { id: order.listingId, status: 'RESERVED' },
      data: { status: 'ACTIVE' },
    });
    refunded += 1;
    logger.info({ orderId: order.id, status }, 'expired escrow hold refunded');

    if (order.buyer.email) {
      await sendEmail({
        to: order.buyer.email,
        subject: 'Холд по заказу истёк, оплата возвращена',
        template: 'order-updated',
        templateData: { orderId: order.id },
        text: 'Срок удержания оплаты по заказу истёк, холд отменён. Если товар всё ещё нужен — оформите заказ заново.',
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'expired hold email failed'));
    }
  }

  return { checked: stale.length, refunded };
}