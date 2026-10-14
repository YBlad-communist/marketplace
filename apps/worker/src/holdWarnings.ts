import { prisma } from '@marketplace/db';
import { HOLD_WARN_12H_MS, HOLD_WARN_2D_MS } from '@marketplace/shared';
import { logger, sendEmail } from './mailer.js';

/**
 * Предупреждения покупателя о скором сгорании холда: за 2 дня и за 12 часов
 * до holdExpiresAt — письмо покупателю и (через флаги holdWarned*) баннер
 * на странице заказа. Джоба чисто БД-шная, без ЮKassa, ходит раз в час.
 *
 * Одноразовость гарантирует атомарный клейм флага (updateMany с условием
 * `null`): при параллельных прогонах письмо уходит ровно один раз.
 */
async function warnOnce(
  windowMs: number,
  flag: 'holdWarned2dAt' | 'holdWarned12hAt',
  subject: string,
  textFor: (hoursLeft: number) => string
): Promise<number> {
  const now = Date.now();
  const orders = await prisma.order.findMany({
    where: {
      status: { in: ['PAID', 'SHIPPED'] },
      holdExpiresAt: { not: null, gt: new Date(now), lte: new Date(now + windowMs) },
      [flag]: null,
    },
    take: 200,
    select: {
      id: true,
      holdExpiresAt: true,
      listing: { select: { title: true } },
      buyer: { select: { email: true } },
    },
  });

  let warned = 0;
  for (const order of orders) {
    if (!order.holdExpiresAt) continue;
    const claimed = await prisma.order.updateMany({
      where: { id: order.id, [flag]: null },
      data: { [flag]: new Date() },
    });
    if (claimed.count !== 1) continue;
    warned += 1;

    if (!order.buyer.email) continue;
    const hoursLeft = Math.max(1, Math.round((order.holdExpiresAt.getTime() - now) / 3_600_000));
    await sendEmail({
      to: order.buyer.email,
      subject,
      template: 'order-updated',
      templateData: { orderId: order.id },
      text: textFor(hoursLeft),
    }).catch((err) => logger.warn({ err, orderId: order.id }, 'hold warning email failed'));
  }
  return warned;
}

export async function checkHoldWarningsJob(): Promise<{ warned2d: number; warned12h: number }> {
  const warned2d = await warnOnce(HOLD_WARN_2D_MS, 'holdWarned2dAt', 'Осталось 2 дня: подтвердите получение товара', () =>
    'До окончания срока удержания оплаты по вашему заказу осталось около 2 дней. ' +
      'Как получите товар — подтвердите получение, и средства перейдут продавцу. ' +
      'Если товар не пришёл или есть проблемы — откройте спор на странице заказа. ' +
      'После окончания срока спор рассмотрит модератор.'
  );

  const warned12h = await warnOnce(
    HOLD_WARN_12H_MS,
    'holdWarned12hAt',
    'Скоро истечёт срок удержания оплаты (12 часов)',
    () =>
      'Меньше 12 часов осталось подтвердить получение товара по заказу. ' +
      'После окончания срока удержания заказ уйдёт на проверку модератору: ' +
      'подтвердите получение или откройте спор на странице заказа.'
  );

  return { warned2d, warned12h };
}
