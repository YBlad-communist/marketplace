import { prisma } from '@marketplace/db';
import { getPaymentProvider } from '@marketplace/payments';
import { expiredHoldCancelIdempotencyKey } from '@marketplace/shared';
import type { NormalizedPaymentStatus } from '@marketplace/shared';
import { env } from './config.js';
import { logger, sendEmail } from './mailer.js';

/**
 * Решение по нормализованному статусу платежа для зависшего PAID-заказа.
 * - 'held'    — холд жив (authorized): заказ ждёт покупателя;
 * - 'expired' — холд мёртв (canceled) или деньги так и не авторизованы
 *               (pending): провайдер рано или поздно закроет платёж сам,
 *               заказ в БД не должен вечно висеть с залоченным объявлением;
 * - 'unknown' — непонятное состояние, не трогаем, только лог.
 */
export function decideHoldOutcome(status: NormalizedPaymentStatus): 'held' | 'expired' | 'unknown' {
  if (status === 'authorized') return 'held';
  if (status === 'canceled' || status === 'pending') return 'expired';
  return 'unknown';
}

/**
 * Периодическая чистка зависших эскроу-холдов.
 * Провайдер (ЮKassa/Монета/мок) сам отменяет не завершённые capture (~7 дней),
 * а заказ в БД навсегда остался бы PAID с залоченным объявлением. Находим
 * такие заказы, сверяемся с провайдером и переводим в REFUNDED + снимаем резерв.
 *
 * Отдельно: SHIPPED-заказы, по которым покупатель промолчал до конца холда,
 * НЕ возвращаем автоматически — переводим в DISPUTED, решением занимается
 * модератор (деньги могли уже участвовать в споре, товар — у покупателя).
 */
export async function checkExpiredHoldsJob(): Promise<{ checked: number; refunded: number; disputed: number }> {
  const ttlMs = Math.max(1, env.YOOKASSA_HOLD_TTL_DAYS) * 86400_000;
  const cutoff = new Date(Date.now() - ttlMs);

  // Срок берём из holdExpiresAt; для заказов, созданных до появления поля,
  // фолбэк на createdAt (тот же смысл «создан давно»).
  const expiredSince = {
    OR: [{ holdExpiresAt: { lt: cutoff } }, { holdExpiresAt: null, createdAt: { lt: cutoff } }],
  };

  // --- SHIPPED: конец холда -> DISPUTED (не авто-возврат) ------------------
  // Работает только с БД, без платежей — поэтому до проверки isConfigured.
  const shippedStale = await prisma.order.findMany({
    where: { status: 'SHIPPED', ...expiredSince },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      listing: { select: { title: true, seller: { select: { email: true } } } },
      buyer: { select: { email: true } },
    },
  });

  let disputed = 0;
  for (const order of shippedStale) {
    // Клейм SHIPPED -> DISPUTED + запись спора одной транзакцией: гонку с
    // release (SHIPPED -> RELEASING) и с повторным прогоном решает updateMany.
    const opened = await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: 'SHIPPED' },
        data: { status: 'DISPUTED' },
      });
      if (claimed.count !== 1) return false;
      await tx.dispute.upsert({
        where: { orderId: order.id },
        update: {},
        create: {
          orderId: order.id,
          reason: 'Истёк срок удержания оплаты',
          comment:
            'Автоматический спор: покупатель не подтвердил получение до конца срока холда. ' +
            'Деньги остаются удержаны, решение примет модератор.',
        },
      });
      return true;
    });
    if (!opened) {
      logger.info({ orderId: order.id }, 'expired holds: shipped order left SHIPPED before update, skipping');
      continue;
    }
    disputed += 1;
    logger.info({ orderId: order.id }, 'expired hold on shipped order moved to DISPUTED');

    const mail = { template: 'order-updated' as const, templateData: { orderId: order.id } };
    if (order.buyer.email) {
      await sendEmail({
        to: order.buyer.email,
        subject: 'Срок подтверждения по заказу истёк — открыт спор',
        ...mail,
        text: `Вы не подтвердили получение товара «${order.listing.title}» до конца срока удержания оплаты. Заказ переведён в спор, деньги удержаны до решения модератора.`,
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'expired hold dispute email (buyer) failed'));
    }
    if (order.listing.seller.email) {
      await sendEmail({
        to: order.listing.seller.email,
        subject: 'По заказу открыт спор (истёк срок холда)',
        ...mail,
        text: `Покупатель не подтвердил получение товара «${order.listing.title}» до конца срока холда. Заказ переведён в спор, деньги удержаны до решения модератора.`,
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'expired hold dispute email (seller) failed'));
    }
  }

  const paymentProvider = getPaymentProvider();
  if (!paymentProvider.isConfigured()) {
    logger.warn({ provider: paymentProvider.name }, 'payment provider is not configured, skipping expired holds check');
    return { checked: 0, refunded: 0, disputed };
  }

  const stale = await prisma.order.findMany({
    where: { status: 'PAID', ...expiredSince },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      listingId: true,
      provider: true,
      providerPaymentId: true,
      yookassaPaymentId: true,
      buyer: { select: { email: true } },
    },
  });

  let refunded = 0;
  for (const order of stale) {
    const paymentId = order.providerPaymentId ?? order.yookassaPaymentId;
    if (!paymentId) continue;
    let status: NormalizedPaymentStatus;
    try {
      const result = await paymentProvider.getStatus(paymentId);
      status = result.status;
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
      // Непомеченный как оплаченный платёж: понуждаем провайдер закрыть холд
      // (ждём его статус canceled), затем финальный клейм ниже не сработает,
      // а заказ удаляется/освобождается через следующую итерацию/вебхук.
      await paymentProvider
        .cancel(paymentId, expiredHoldCancelIdempotencyKey(order.id))
        .catch((err) => logger.warn({ err, orderId: order.id }, 'expired holds: cancel failed, will recheck'));
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

  return { checked: stale.length, refunded, disputed };
}
