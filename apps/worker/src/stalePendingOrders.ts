import { prisma } from '@marketplace/db';
import { cancelKeyFor, getPaymentProvider } from '@marketplace/payments';
import type { NormalizedPaymentStatus } from '@marketplace/shared';
import { logger, sendEmail } from './mailer.js';

/** Возраст PENDING-заказа, после которого джоба считает его брошенным. */
const STALE_PENDING_MS = 60 * 60_000;

/**
 * Решение по статусу платежа для зависшего PENDING-заказа:
 * - 'paid'     — авторизация дошла (вебхук потерян) -> доводим до PAID;
 * - 'canceled' — платёж мёртв -> удаляем заказ, снимаем резерв;
 * - 'open'     — холд ещё жив (pending/authorized) -> отменяем платёж;
 * - 'unknown'  — непонятно, не трогаем.
 */
export function decidePendingOutcome(
  status: NormalizedPaymentStatus
): 'paid' | 'canceled' | 'open' | 'unknown' {
  if (status === 'authorized' || status === 'captured') return 'paid';
  if (status === 'canceled') return 'canceled';
  if (status === 'pending') return 'open';
  return 'unknown';
}

/**
 * Чистка брошенных PENDING-заказов старше 60 минут: покупатель начал оплату
 * и бросил страницу — заказ висит с залоченным объявлением навсегда.
 * Сверяемся с провайдером, отменяем открытый платёж, удаляем заказ и
 * возвращаем объявление в ACTIVE.
 */
export async function cleanupStalePendingOrdersJob(): Promise<{
  checked: number;
  deleted: number;
  promoted: number;
}> {
  const cutoff = new Date(Date.now() - STALE_PENDING_MS);
  const stale = await prisma.order.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      listingId: true,
      providerPaymentId: true,
      yookassaPaymentId: true,
      buyer: { select: { email: true, name: true } },
      listing: { select: { title: true } },
    },
  });
  if (stale.length === 0) return { checked: 0, deleted: 0, promoted: 0 };

  const provider = getPaymentProvider();
  if (!provider.isConfigured()) {
    logger.warn({ provider: provider.name }, 'payment provider is not configured, skipping stale pending cleanup');
    return { checked: 0, deleted: 0, promoted: 0 };
  }

  let deleted = 0;
  let promoted = 0;
  for (const order of stale) {
    const paymentId = order.providerPaymentId ?? order.yookassaPaymentId;
    let outcome: 'paid' | 'canceled' | 'open' | 'unknown' = 'open';
    if (paymentId) {
      let status: NormalizedPaymentStatus;
      try {
        const result = await provider.getStatus(paymentId);
        status = result.status;
      } catch (err) {
        logger.warn({ err, orderId: order.id }, 'stale pending: payment lookup failed, skipping');
        continue;
      }
      outcome = decidePendingOutcome(status);
      if (outcome === 'unknown') {
        logger.warn({ orderId: order.id, status }, 'stale pending: unexpected payment status');
        continue;
      }
      if (outcome === 'paid') {
        // Вебхук потерялся, но деньги авторизованы — доводим заказ до PAID,
        // как это сделал бы webhook authorized/captured.
        const claimed = await prisma.order.updateMany({
          where: { id: order.id, status: 'PENDING' },
          data: { status: 'PAID' },
        });
        if (claimed.count === 1) {
          promoted += 1;
          logger.info({ orderId: order.id, paymentId }, 'stale pending order promoted to PAID');
        }
        continue;
      }
      if (outcome === 'open') {
        // Понуждаем провайдер закрыть холд; после cancel вебхук/следующий
        // прогон удалит заказ по ветке canceled.
        await provider
          .cancel(paymentId, cancelKeyFor(order.id))
          .catch((err) => logger.warn({ err, orderId: order.id }, 'stale pending: cancel failed, will recheck'));
        continue;
      }
      // canceled: платёж уже мёртв — падаем в удаление заказа ниже.
    }

    // Атомарный клейм: между чтением списка и записью заказ мог уйти в PAID
    // (webhook) — тогда updateMany проиграет и заказ не трогаем.
    const doomed = await prisma.order.deleteMany({
      where: { id: order.id, status: 'PENDING' },
    });
    if (doomed.count === 0) {
      logger.info({ orderId: order.id }, 'stale pending: order left PENDING before delete, skipping');
      continue;
    }
    await prisma.listing.updateMany({
      where: { id: order.listingId, status: 'RESERVED' },
      data: { status: 'ACTIVE' },
    });
    deleted += 1;
    logger.info({ orderId: order.id, paymentId }, 'stale pending order deleted');

    if (order.buyer.email) {
      await sendEmail({
        to: order.buyer.email,
        subject: 'Заказ отменён: оплата не была завершена',
        template: 'order-updated',
        templateData: { orderId: order.id },
        text:
          `Заказ «${order.listing.title}» отменён: оплата не была завершена в течение часа. ` +
          'Если товар всё ещё нужен — оформите заказ заново.',
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'stale pending email failed'));
    }
  }

  return { checked: stale.length, deleted, promoted };
}
