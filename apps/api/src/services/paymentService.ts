import { Order, prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { enqueueEmail } from './notificationService.js';
import {
  cancelKeyFor,
  cancelYookassaPayment,
  captureKeyFor,
  captureYookassaPayment,
  createYookassaPayment,
  getYookassaPayment,
  isTrustedYookassaIp,
  refundCancelKeyFor,
  refundKeyFor,
  refundYookassaPayment,
  toAmount,
  type YooPayment,
} from '../lib/yookassa.js';

/**
 * ЭСКРОУ-ПАТТЕРН на ЮKassa (split payments, двухстадийные платежи).
 * 1. Покупатель платит через виджет -> деньги авторизованы и УДЕРЖАНЫ (pending -> waiting_for_capture).
 * 2. Покупатель подтверждает получение -> capture: деньги попадают продавцу по transfers,
 *    комиссия платформы удерживается через platform_fee_amount.
 * 3. Возврат -> cancel холда (waiting_for_capture) или refund после capture (succeeded).
 * Никаких отдельных сущностей «перевода» не требуется: распределение задано в transfers
 * при создании платежа, capture раскладывает сумму автоматически.
 */

export function platformFeeForAmount(amount: number): number {
  return Number(((amount * env.YOOKASSA_PLATFORM_FEE_BASIS_POINTS) / 10000).toFixed(2));
}

/**
 * Возврат объявления в выдачу после отмены/провала оплаты.
 * Трогаем только RESERVED, чтобы случайно не реактивировать
 * отклонённое модератором или снятое продавцом объявление.
 */
async function unlockListing(listingId: string): Promise<void> {
  await prisma.listing.updateMany({
    where: { id: listingId, status: 'RESERVED' },
    data: { status: 'ACTIVE' },
  });
}

/** Уведомление администратора о спорной ситуации (если задан ADMIN_EMAIL). */
async function notifyAdmin(subject: string, text: string): Promise<void> {
  if (!env.ADMIN_EMAIL) return;
  await enqueueEmail({
    to: env.ADMIN_EMAIL,
    subject,
    template: 'order-updated',
    templateData: {},
    text,
  }).catch((err) => logger.warn({ err }, 'admin notification failed'));
}

/**
 * Подключение продавца к ЮKassa. Онбординг магазина выполняется в личном
 * кабинете ЮKassa (API не предоставляет публичной кнопки Connect для платформ),
 * здесь мы только сохраняем Shop ID магазина-продавца для сплитования.
 */
export async function ensureSellerYookassa(sellerId: string, shopId: string): Promise<{ shopId: string }> {
  const seller = await prisma.user.findUnique({ where: { id: sellerId } });
  if (!seller) throw new AppError(errorCodes.NOT_FOUND, 'Продавец не найден', 404);

  const normalized = shopId.trim();
  if (!normalized) {
    throw new AppError(errorCodes.VALIDATION, 'Укажите Shop ID магазина ЮKassa', 400);
  }

  await prisma.user.update({
    where: { id: sellerId },
    data: { yookassaShopId: normalized, yookassaOnboarded: true },
  });
  return { shopId: normalized };
}

export async function createEscrowOrder(input: {
  listingId: string;
  buyerId: string;
  idempotencyKey: string;
}): Promise<{ order: Order; confirmationToken: string; paymentId: string }> {
  // Сначала проверяем идемпотентность — повторный запрос с тем же ключом
  // должен вернуть существующий заказ, а не создавать дубликат.
  const existingOrder = await prisma.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existingOrder) {
    if (existingOrder.listingId !== input.listingId) {
      throw new AppError(errorCodes.CONFLICT, 'Idempotency-ключ уже использован', 409);
    }
    if (existingOrder.yookassaPaymentId) {
      const payment = await getYookassaPayment(existingOrder.yookassaPaymentId);
      const token = payment.confirmation?.confirmation_token;
      if (!token) {
        throw new AppError(errorCodes.CONFLICT, 'Платёж по заказу уже завершён', 409);
      }
      return { order: existingOrder, confirmationToken: token, paymentId: existingOrder.yookassaPaymentId };
    }
    throw new AppError(errorCodes.CONFLICT, 'Заказ уже существует', 409);
  }

  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    include: { order: true, seller: { select: { yookassaShopId: true, yookassaOnboarded: true, id: true } } },
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
  if (!listing.seller.yookassaShopId || !listing.seller.yookassaOnboarded) {
    throw new AppError(
      errorCodes.PAYMENT_REQUIRED,
      'Продавец ещё не подключил выплаты. Свяжитесь с продавцом.',
      402
    );
  }

  const amount = Number(listing.price);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError(errorCodes.VALIDATION, 'Некорректная цена', 400);
  }
  if (listing.currency !== 'RUB') {
    // Защитный сетевой слой: БД/схема не позволяют создать не-RUB объявление,
    // но если данные были внесены в обход validation — не списываем в валюте.
    throw new AppError(errorCodes.CONFLICT, 'Оплата доступна только в рублях (RUB)', 409);
  }

  const fee = platformFeeForAmount(amount);
  const sellerAmount = Number((amount - fee).toFixed(2));
  if (sellerAmount <= 0) {
    throw new AppError(errorCodes.VALIDATION, 'Комиссия платформы превышает цену', 400);
  }

  const payment = await createYookassaPayment({
    amount,
    description: `Оплата заказа на платформе (объявление: ${listing.title})`,
    metadata: {
      orderKey: input.idempotencyKey,
      listingId: listing.id,
      buyerId: input.buyerId,
    },
    transfers: [
      {
        account_id: listing.seller.yookassaShopId,
        amount: toAmount(sellerAmount),
        platform_fee_amount: toAmount(fee),
        description: `Выплата за объявление «${listing.title}».`,
      },
    ],
    idempotencyKey: input.idempotencyKey,
  });
  const confirmationToken = payment.confirmation?.confirmation_token;
  if (!confirmationToken) {
    await cancelYookassaPayment(payment.id, cancelKeyFor(input.idempotencyKey)).catch(() => undefined);
    throw new AppError(errorCodes.INTERNAL, 'ЮKassa не выдала токен виджета', 502);
  }

  const order = await prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId: input.buyerId,
      amount: listing.price,
      currency: listing.currency,
      yookassaPaymentId: payment.id,
      idempotencyKey: input.idempotencyKey,
    },
  }).catch(async (err: unknown) => {
    // Гонка двух параллельных POST /orders: второй получает 409, а не 500.
    // Созданный нами платёж отменяем, чтобы не висел сиротой-холдом.
    if (
      typeof err === 'object' && err !== null &&
      'code' in err && (err as { code?: string }).code === 'P2002'
    ) {
      await cancelYookassaPayment(payment.id, cancelKeyFor(input.idempotencyKey)).catch(() => undefined);
      throw new AppError(errorCodes.CONFLICT, 'По этому объявлению уже есть заказ', 409);
    }
    throw err;
  });

  // Резервируем объявление на время оплаты: уходит из выдачи (фильтр ACTIVE),
  // повторная покупка упрётся в проверку статуса выше с понятным 409.
  const reserved = await prisma.listing.updateMany({
    where: { id: listing.id, status: 'ACTIVE' },
    data: { status: 'RESERVED' },
  });
  if (reserved.count === 0) {
    // Статус увели из-под нас (модерация/снятие) — откатываем заказ и холд.
    await prisma.order.delete({ where: { id: order.id } }).catch(() => undefined);
    await cancelYookassaPayment(payment.id, cancelKeyFor(input.idempotencyKey)).catch(() => undefined);
    throw new AppError(errorCodes.CONFLICT, 'Объявление недоступно для покупки', 409);
  }

  return { order, confirmationToken, paymentId: payment.id };
}

export async function releaseOrder(orderId: string, actorId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { seller: true } } },
  });
  if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
  if (order.buyerId !== actorId) {
    throw new AppError(errorCodes.FORBIDDEN, 'Подтвердить получение может только покупатель', 403);
  }
  // Эскроу: release только после авторизации средств (PAID = waiting_for_capture).
  // PENDING означает, что деньги ещё не удержаны — capture упадёт в ЮKassa.
  if (order.status !== 'PAID') {
    throw new AppError(errorCodes.CONFLICT, `Нельзя подтвердить заказ в статусе ${order.status}`, 409);
  }
  if (!order.yookassaPaymentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  // Атомарный переход PAID -> RELEASING (тот же паттерн, что и отсчёт RESERVED
  // в createEscrowOrder): гонку двух параллельных release решает updateMany,
  // а не чтение-проверка. Проигравший получает 409 и не доходит до ЮKassa —
  // двойной выплаты не бывает даже при двух одновременных запросах.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: 'PAID' },
    data: { status: 'RELEASING' },
  });
  if (claimed.count !== 1) {
    throw new AppError(errorCodes.CONFLICT, 'Выплата уже обрабатывается', 409);
  }

  await performRelease(order);

  const sellerEmail = order.listing.seller.email;
  if (sellerEmail) {
    await enqueueEmail({
      to: sellerEmail,
      subject: 'Заказ подтверждён и выплата отправлена',
      template: 'order-updated',
      templateData: { orderId: order.id, amount: String(order.amount) },
      text: `Покупатель подтвердил получение. Средства переведены на ваш счёт ЮKassa.`,
    });
  }
}

/**
 * Выплата: capture сплит-платежа + финальная транзакция.
 *
 * Идемпотентность: capture идёт с Idempotence-Key `release-capture-{orderId}`
 * (единый с recovery-джобой worker'а — см. shared/constants). Если процесс
 * падает между capture и финальной транзакцией, повторный прогон с тем же
 * ключом ЮKassa «дедуплицирует» операцию и возвращает исходный результат.
 * Финальный переход RELEASING -> RELEASED дополнительно гейтится по статусу:
 * если заказ уже доведён, листинг не переворачивается повторно.
 */
export async function performRelease(order: {
  id: string;
  listingId: string;
  amount: unknown;
  currency: string;
  yookassaPaymentId: string | null;
  idempotencyKey: string | null;
  listing?: { seller?: { yookassaShopId?: string | null } } | null;
}): Promise<void> {
  if (!order.yookassaPaymentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  const payment = await captureYookassaPayment(order.yookassaPaymentId, captureKeyFor(order.id));
  if (payment.status !== 'succeeded') {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не может быть завершён', 409);
  }

  const fee = platformFeeForAmount(Number(order.amount));

  const finished = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: 'RELEASING' },
      data: {
        status: 'RELEASED',
        platformFee: fee,
        releasedAt: new Date(),
      },
    });
    if (updated.count !== 1) return false;
    await tx.listing.updateMany({
      where: { id: order.listingId, status: 'RESERVED' },
      data: { status: 'SOLD' },
    });
    return true;
  });

  if (!finished) {
    logger.warn({ orderId: order.id, paymentId: order.yookassaPaymentId }, 'release already completed by a concurrent run');
  }
}

export async function refundOrder(orderId: string, actorId: string, role: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
  const isBuyer = order.buyerId === actorId;
  const isStaff = role === 'ADMIN' || role === 'MODERATOR';
  if (!isBuyer && !isStaff) {
    throw new AppError(errorCodes.FORBIDDEN, 'Нет прав на возврат', 403);
  }
  // REFUNDING — возврат уже движется: повторный вызов (двойной клик, ретрай
  // после таймаута, одновременное действие покупателя и модератора) получает 409.
  if (order.status === 'REFUNDING') {
    throw new AppError(errorCodes.CONFLICT, 'Возврат уже обрабатывается', 409);
  }
  // RELEASING/RELEASED — деньги движутся/ушли к продавцу: возврат запрещён
  // (деньги уже вне эскроу; платформа получает их назад только отдельным
  // refund из средств продавца — такие случаи разбирает админ вручную).
  if (order.status === 'RELEASED' || order.status === 'RELEASING' || order.status === 'REFUNDED') {
    throw new AppError(errorCodes.CONFLICT, `Нельзя вернуть заказ в статусе ${order.status}`, 409);
  }
  if (!order.yookassaPaymentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  // Атомарный клейм возврата (PAID/…/DISPUTED -> REFUNDING). Гонку двух
  // параллельных refundOrder решает updateMany, как у releaseOrder: проигравший
  // получает 409 и НЕ доходит до ЮKassa, поэтому двойного cancel/refund не бывает.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: { in: ['PENDING', 'PAID', 'DISPUTED'] } },
    data: { status: 'REFUNDING' },
  });
  if (claimed.count !== 1) {
    throw new AppError(errorCodes.CONFLICT, 'Возврат уже обрабатывается', 409);
  }

  const previousStatus = order.status;
  try {
    const payment = await getYookassaPayment(order.yookassaPaymentId);
    if (payment.status === 'succeeded') {
      // Деньги уже удержаны после capture — оформляем полный возврат
      // (комиссия платформы возвращается за счёт магазина продавца).
      await refundYookassaPayment(order.yookassaPaymentId, Number(order.amount), refundKeyFor(order.id));
    } else if (payment.status === 'waiting_for_capture' || payment.status === 'pending') {
      await cancelYookassaPayment(order.yookassaPaymentId, refundCancelKeyFor(order.id)).catch(async (err) => {
        // Могли опоздать: холд истёк и ЮKassa уже отменила платёж сама.
        const now = await getYookassaPayment(order.yookassaPaymentId!);
        if (now.status === 'canceled') return; // деньги уже вернулись покупателю
        throw err;
      });
    } else if (payment.status === 'canceled') {
      // Деньги уже вернулись покупателю (авто-отмена истёкшего холда) — идемпотентно завершаем.
      logger.info({ orderId: order.id, paymentId: order.yookassaPaymentId }, 'refund: payment already canceled');
    } else {
      throw new AppError(errorCodes.CONFLICT, 'Платёж в неподходящем статусе', 409);
    }
  } catch (err) {
    // ЮKassa недоступна/отклонила — не оставляем заказ навсегда в REFUNDING:
    // возвращаем статус, с которого клеймили. Гейтим по REFUNDING, чтобы не
    // затереть параллельный переход (например, вебхук уже провёл REFUNDED).
    await prisma.order.updateMany({
      where: { id: order.id, status: 'REFUNDING' },
      data: { status: previousStatus },
    });
    logger.warn({ err, orderId: order.id }, 'refund: yookassa call failed, order moved back from REFUNDING');
    throw err;
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({
      where: { id: order.id, status: 'REFUNDING' },
      data: { status: 'REFUNDED' },
    });
    await tx.listing.updateMany({
      where: { id: order.listingId, status: 'RESERVED' },
      data: { status: 'ACTIVE' },
    });
  });
}

/**
 * Вебхук ЮKassa. Подписи нет: подлинность уведомления проверяем по
 * 1) IP из официального аллоулиста ЮKassa; 2) повторному GET текущего статуса
 * платежа (сверяем со статусом из уведомления). Идемпотентность — через redis.
 */
export async function handleYookassaNotification(
  rawBody: Buffer,
  ip?: string
): Promise<{ received: boolean; handled?: string }> {
  if (!env.YOOKASSA_INSECURE_WEBHOOKS && (!ip || !isTrustedYookassaIp(ip))) {
    logger.warn({ ip }, 'yookassa webhook from untrusted ip');
    throw new AppError(errorCodes.UNAUTHORIZED, 'Неизвестный отправитель уведомления', 401);
  }

  let body: { type?: string; event?: string; object?: unknown };
  try {
    body = JSON.parse(rawBody.toString('utf8')) as typeof body;
  } catch {
    throw new AppError(errorCodes.VALIDATION, 'Некорректное тело уведомления', 400);
  }
  if (body.type !== 'notification') {
    throw new AppError(errorCodes.VALIDATION, 'Ожидалось уведомление ЮKassa', 400);
  }
  const event = body.event;
  const object = body.object as
    | ({ id?: string; payment_id?: string; status?: string } & Record<string, unknown>)
    | undefined;
  if (!event || !object?.id) {
    throw new AppError(errorCodes.VALIDATION, 'Некорректное уведомление', 400);
  }

  const redis = getRedis();
  const dedupe = await redis.set(`yookassa:webhook:${event}:${object.id}`, '1', 'EX', 86400, 'NX');
  if (dedupe !== 'OK') {
    return { received: true, handled: 'duplicate' };
  }

  if (event === 'refund.succeeded') {
    const paymentId = object.payment_id;
    if (!paymentId) return { received: true, handled: event };
    const payment = await getYookassaPayment(paymentId).catch((err) => {
      logger.warn({ err, paymentId }, 'yookassa refund webhook: payment lookup failed, skipping');
      return null;
    });
    if (!payment) return { received: true, handled: 'verification_failed' };

    const existing = await prisma.order.findFirst({
      where: { yookassaPaymentId: paymentId },
      select: { id: true, listingId: true, status: true },
    });
    if (!existing) return { received: true, handled: event };

    if (existing.status === 'RELEASED' || existing.status === 'RELEASING') {
      // Деньги уже переведены продавцу (или переводятся): платформа получила
      // возврат средств продавца, но «авто-возврат» покупателю тут запрещён —
      // иначе сумма спишется дважды. Статус не трогаем, уведомляем админа.
      logger.warn({
        orderId: existing.id, paymentId, refundId: object.id, status: existing.status,
      }, 'refund after pay-out; manual resolution required');
      await notifyAdmin(
        'Возврат по уже выплаченной сделке',
        `Refund ${object.id} по платежу ${paymentId} на сумму ${payment.amount?.value ?? '?'} RUB. ` +
          `Заказ ${existing.id} уже переведён продавцу (статус ${existing.status}): ` +
          `возврат покупателю оформите вручную через кабинет ЮKassa.`
      );
      return { received: true, handled: event };
    }

    const marked = await prisma.order.updateMany({
      where: { yookassaPaymentId: paymentId, status: { notIn: ['REFUNDED', 'RELEASING', 'RELEASED', 'DISPUTED'] } },
      data: { status: 'REFUNDED' },
    });
    if (marked.count > 0) {
      const target = await prisma.order.findFirst({
        where: { yookassaPaymentId: paymentId },
        select: { listingId: true },
      });
      if (target) await unlockListing(target.listingId);
      logger.info({ orderId: existing.id, paymentId, refundId: object.id }, 'payment refunded via webhook');
    }
    return { received: true, handled: event };
  }

  // Остальные события — платежи. Платёж ищем по id из уведомления.
  const paymentId = (object as { id: string }).id;
  const payment = await getYookassaPayment(paymentId).catch((err) => {
    logger.warn({ err, paymentId }, 'yookassa payment webhook: payment lookup failed, skipping');
    return null;
  });
  if (!payment || payment.status !== object.status) {
    // Устаревшая/повторная доставка: статус в уведомлении не совпал с текущим.
    logger.warn({ paymentId, event, objectStatus: object.status, currentStatus: payment?.status }, 'yookassa webhook status mismatch, skipping');
    return { received: true, handled: 'stale' };
  }

  const orderKey = payment.metadata?.orderKey;
  switch (payment.status) {
    case 'waiting_for_capture': {
      // Эскроу: средства авторизованы и удерживаются платформой.
      if (orderKey) {
        await prisma.order.updateMany({
          where: { idempotencyKey: orderKey, status: 'PENDING' },
          data: { status: 'PAID' },
        });
      }
      break;
    }
    case 'succeeded': {
      // Succeeded наступает ПОСЛЕ capture в releaseOrder (или вручную из
      // кабинета ЮKassa). Никогда не делаем авто-RELEASE без подтверждения
      // покупателя: только доводим PENDING/PAID до PAID.
      if (orderKey) {
        const existing = await prisma.order.findUnique({
          where: { idempotencyKey: orderKey },
          select: { id: true, status: true },
        });
        if (existing && (existing.status === 'PENDING' || existing.status === 'PAID')) {
          await prisma.order.update({
            where: { id: existing.id },
            data: { status: 'PAID' },
          });
          logger.info({ orderKey, paymentId }, 'escrow authorized, awaiting buyer confirmation');
        }
      }
      break;
    }
    case 'canceled': {
      // Оплата не состоялась или холд отменён. PENDING-заказ удаляем (иначе он
      // заблокирует повторную покупку), PAID/… переводим в REFUNDED (деньги уже
      // вернулись покупателю) и снимаем резерв с объявления.
      if (orderKey) {
        const doomed = await prisma.order.findFirst({
          where: { idempotencyKey: orderKey, status: 'PENDING' },
          select: { id: true, listingId: true },
        });
        if (doomed) {
          await prisma.order.delete({ where: { id: doomed.id } });
          await unlockListing(doomed.listingId);
        }
      }
      const held = await prisma.order.updateMany({
        where: { yookassaPaymentId: paymentId, status: { in: ['PAID', 'DISPUTED'] } },
        data: { status: 'REFUNDED' },
      });
      if (held.count > 0) {
        const target = await prisma.order.findFirst({
          where: { yookassaPaymentId: paymentId },
          select: { listingId: true },
        });
        if (target) await unlockListing(target.listingId);
      }
      break;
    }
    default:
      break;
  }
  return { received: true, handled: event };
}

/** Сверка DI/приватных хелперов для внутренних нужд. */
export type { YooPayment };