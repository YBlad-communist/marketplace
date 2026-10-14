import { prisma } from '@marketplace/db';
import { getPaymentProvider } from '@marketplace/payments';
import { releaseCaptureIdempotencyKey } from '@marketplace/shared';
import type { NormalizedPaymentStatus } from '@marketplace/shared';
import { env } from './config.js';
import { logger, sendEmail } from './mailer.js';

/**
 * Решение по нормализованному статусу платежа для застрявшего в RELEASING заказа.
 * - 'finish' — деньги доступны (captured — уже распределены, authorized — холд
 *              жив): доводим выплату повторным confirm (идемпотентно, тот же
 *              ключ, что и API);
 * - 'refund' — платёж мёртв (canceled): переводим заказ в REFUNDED и снимаем
 *              резерв с объявления (деньги уже вернулись покупателю или не были списаны);
 * - 'skip'   — непонятное состояние, не трогаем, только лог.
 */
export function decideReleasingOutcome(status: NormalizedPaymentStatus): 'finish' | 'refund' | 'skip' {
  if (status === 'captured' || status === 'authorized') return 'finish';
  if (status === 'canceled') return 'refund';
  return 'skip';
}

/**
 * Recovery-джоба: заказы, застрявшие в RELEASING (процесс упал между capture
 * и финальной транзакцией). Сверяемся с платёжным провайдером и доводим заказ
 * до конца.
 *
 * Идемпотентность строится на том же, что и releaseOrder:
 * - confirm идёт с тем же ключом (release-capture-{id}) — повторный прогон не
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
  const paymentProvider = getPaymentProvider();
  if (!paymentProvider.isConfigured()) {
    logger.warn({ provider: paymentProvider.name }, 'payment provider is not configured, skipping releasing recovery');
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
      provider: true,
      providerPaymentId: true,
      yookassaPaymentId: true,
      idempotencyKey: true,
      buyer: { select: { email: true } },
      listing: {
        select: {
          seller: { select: { email: true, payoutAccountId: true } },
        },
      },
    },
  });

  let finished = 0;
  let refunded = 0;
  for (const order of stale) {
    const paymentId = order.providerPaymentId ?? order.yookassaPaymentId;
    if (!paymentId) continue;

    let status: NormalizedPaymentStatus;
    try {
      const result = await paymentProvider.getStatus(paymentId);
      status = result.status;
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
        await finishReleasingOrder(order, paymentId);
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
 * performRelease (apps/api): confirm сплит-платежа + транзакция RELEASING->RELEASED.
 * Распределение по transfers было задано при создании платежа (ЮKassa);
 * Монета при confirm требует sellerAccountRef + суммы — грузим из БД.
 * Повторный confirm с тем же ключом идемпотентен.
 */
async function finishReleasingOrder(
  order: {
    id: string;
    listingId: string;
    amount: unknown;
    currency: string;
    providerPaymentId: string | null;
    yookassaPaymentId: string | null;
    idempotencyKey: string | null;
    listing?: { seller?: { email: string | null; payoutAccountId: string | null } | null } | null;
  },
  paymentId: string
): Promise<void> {
  const paymentProvider = getPaymentProvider();
  const amountNum = Number(order.amount);
  const fee = Number(((amountNum * env.YOOKASSA_PLATFORM_FEE_BASIS_POINTS) / 10000).toFixed(2));
  const sellerAmount = Number((amountNum - fee).toFixed(2));

  // Монета при confirm требует реквизиты продавца (PaymentRequest);
  // ЮKassa/mock transfer игнорируют. Для монеты грузим payoutAccountId.
  let transfer:
    | { sellerAccountRef: string; amountKopecks: number; platformFeeKopecks: number }
    | undefined;
  if (paymentProvider.name === 'moneta') {
    const sellerRef = order.listing?.seller?.payoutAccountId;
    if (!sellerRef) {
      throw new Error('seller payout account not set (moneta)');
    }
    transfer = {
      sellerAccountRef: sellerRef,
      amountKopecks: Math.round(sellerAmount * 100),
      platformFeeKopecks: Math.round(fee * 100),
    };
  }

  const result = await paymentProvider.confirm(
    paymentId,
    releaseCaptureIdempotencyKey(order.id),
    transfer
  );
  if (result.status !== 'captured') {
    throw new Error(`confirm not captured: ${result.status}`);
  }

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
    logger.info({ orderId: order.id, paymentId }, 'stuck releasing order finished by recovery');
    const sellerEmail = order.listing?.seller?.email;
    if (sellerEmail) {
      await sendEmail({
        to: sellerEmail,
        subject: 'Заказ подтверждён и выплата отправлена',
        template: 'order-updated',
        templateData: { orderId: order.id, amount: String(order.amount) },
        text: 'Покупатель подтвердил получение. Средства переведены на ваш счёт.',
      }).catch((err) => logger.warn({ err, orderId: order.id }, 'releasing recovery email failed'));
    }
  }
}
