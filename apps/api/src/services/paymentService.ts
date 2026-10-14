import { Order, prisma } from '@marketplace/db';
import {
  ACTIVE_ORDER_STATUSES,
  AppError,
  errorCodes,
  type PaymentProvider,
} from '@marketplace/shared';
import { env, platformFeeBasisPoints, holdTtlDays } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { buildAssistantPayUrl, monetaAmount } from '../lib/moneta.js';
import { enqueueEmail } from './notificationService.js';
import { getPaymentProvider } from './payments/index.js';
import {
  cancelKeyFor,
  captureKeyFor,
  refundCancelKeyFor,
  refundKeyFor,
} from '../lib/yookassa.js';

/**
 * ЭСКРОУ-ПАТТЕРН («безопасная сделка») за интерфейсом PaymentProvider.
 * 1. Покупатель оплачивает -> средства авторизованы и УДЕРЖАНЫ (холд).
 * 2. Покупатель подтверждает получение -> confirm (capture): средства
 *    распределяются между продавцом и комиссией платформы.
 * 3. Возврат -> cancel холда (до capture) или refund (после capture).
 * Провайдер (ЮKassa/Монета/mock) выбирается по env PAYMENT_PROVIDER;
 * здесь остаётся только бизнес-стейт-машина заказов.
 */

export function platformFeeForAmount(amount: number): number {
  return Number(((amount * platformFeeBasisPoints) / 10000).toFixed(2));
}

/** Сумма заказа в копейках (граница провайдера — целые копейки). */
function toKopecks(amount: unknown): number {
  return Math.round(Number(amount) * 100);
}

/**
 * Реквизит продавца у провайдера. payoutAccountId — провайдер-нейтральное
 * поле; yookassaShopId — legacy-фолбэк на время переезда (тесты и старые
 * записи заполняют только legacy-поля).
 */
function sellerAccountRef(seller: {
  payoutAccountId?: string | null;
  yookassaShopId?: string | null;
}): string | null {
  return seller.payoutAccountId ?? seller.yookassaShopId ?? null;
}

/** Продавец подключил приём выплат (совместимость со старыми записями). */
function sellerOnboarded(seller: {
  payoutOnboarded?: boolean;
  yookassaOnboarded?: boolean;
}): boolean {
  return Boolean(seller.payoutOnboarded || seller.yookassaOnboarded);
}

function providerReady(provider: PaymentProvider): void {
  if (!provider.isConfigured()) {
    throw new AppError(errorCodes.INTERNAL, 'Платёжный провайдер не настроен', 500);
  }
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
 * Подключение продавца к выплатам. Онбординг счёта выполняется в личном
 * кабинете провайдера (API не предоставляет публичной кнопки Connect для
 * платформ), здесь мы только сохраняем реквизит счёта продавца.
 *
 * Legacy: ensureSellerYookassa(sellerId, shopId) — та же функция, поле shopId.
 */
export async function ensureSellerYookassa(sellerId: string, shopId: string): Promise<{ shopId: string }> {
  const result = await ensureSellerPayout(sellerId, shopId);
  return { shopId: result.accountRef };
}

/** Провайдер-нейтральное подключение: сохраняет accountRef в payoutAccountId. */
export async function ensureSellerPayout(
  sellerId: string,
  accountRef: string
): Promise<{ accountRef: string }> {
  const seller = await prisma.user.findUnique({ where: { id: sellerId } });
  if (!seller) throw new AppError(errorCodes.NOT_FOUND, 'Продавец не найден', 404);

  const normalized = accountRef.trim();
  if (!normalized) {
    throw new AppError(errorCodes.VALIDATION, 'Укажите реквизит счёта продавца', 400);
  }

  await prisma.user.update({
    where: { id: sellerId },
    // Legacy-поля пишем наравне с провайдер-нейтральными: старые проверки и
    // тесты работают с yookassa*, новые — с payout*. Удаление legacy — отдельным
    // решением после полного перехода.
    data: {
      yookassaShopId: normalized,
      yookassaOnboarded: true,
      payoutAccountId: normalized,
      payoutOnboarded: true,
    },
  });
  return { accountRef: normalized };
}

/** Текущий статус подключения выплат продавцом (провайдер-нейтральный). */
export async function getSellerPayoutStatus(sellerId: string): Promise<{
  payoutAccountId: string | null;
  payoutOnboarded: boolean;
  // legacy-фолбэк
  yookassaShopId: string | null;
  yookassaOnboarded: boolean;
}> {
  const user = await prisma.user.findUnique({
    where: { id: sellerId },
    select: {
      payoutAccountId: true,
      payoutOnboarded: true,
      yookassaShopId: true,
      yookassaOnboarded: true,
    },
  });
  return {
    payoutAccountId: user?.payoutAccountId ?? null,
    payoutOnboarded: Boolean(user?.payoutOnboarded),
    yookassaShopId: user?.yookassaShopId ?? null,
    yookassaOnboarded: Boolean(user?.yookassaOnboarded),
  };
}

export async function createEscrowOrder(input: {
  listingId: string;
  buyerId: string;
  idempotencyKey: string;
}): Promise<{
  order: Order;
  confirmationToken: string | null;
  payUrl: string | null;
  paymentId: string;
}> {
  const provider = getPaymentProvider();
  providerReady(provider);

  // Сначала проверяем идемпотентность — повторный запрос с тем же ключом
  // должен вернуть существующий заказ, а не создавать дубликат.
  const existingOrder = await prisma.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existingOrder) {
    if (existingOrder.listingId !== input.listingId) {
      throw new AppError(errorCodes.CONFLICT, 'Idempotency-ключ уже использован', 409);
    }
    if (existingOrder.providerPaymentId) {
      const status = await provider.getStatus(existingOrder.providerPaymentId);
      if (provider.name === 'moneta') {
        // Монета: до оплаты у операции нет якоря — пересобираем pay_url
        // по CTID (= idempotencyKey) и сумме заказа.
        if (status.status === 'pending' || status.status === 'unknown') {
          const amountNum = Number(existingOrder.amount);
          const url = buildAssistantPayUrl({
            transactionId: existingOrder.idempotencyKey ?? existingOrder.providerPaymentId,
            amountRub: monetaAmount(amountNum),
            description: undefined,
          });
          return {
            order: existingOrder,
            confirmationToken: null,
            payUrl: url,
            paymentId: existingOrder.providerPaymentId,
          };
        }
        throw new AppError(errorCodes.CONFLICT, 'Платёж по заказу уже завершён', 409);
      }
      const token = status.anchor?.type === 'confirmation_token' ? status.anchor.token : null;
      const payUrl = status.anchor?.type === 'pay_url' ? status.anchor.url : null;
      if (!token && !payUrl) {
        throw new AppError(errorCodes.CONFLICT, 'Платёж по заказу уже завершён', 409);
      }
      return {
        order: existingOrder,
        confirmationToken: token,
        payUrl,
        paymentId: existingOrder.providerPaymentId,
      };
    }
    throw new AppError(errorCodes.CONFLICT, 'Заказ уже существует', 409);
  }

  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    include: {
      seller: {
        select: {
          id: true,
          payoutAccountId: true,
          payoutOnboarded: true,
          yookassaShopId: true,
          yookassaOnboarded: true,
        },
      },
    },
  });
  if (!listing) throw new AppError(errorCodes.NOT_FOUND, 'Объявление не найдено', 404);
  if (listing.sellerId === input.buyerId) {
    throw new AppError(errorCodes.VALIDATION, 'Нельзя купить собственное объявление', 400);
  }
  // Активных заказов у объявления может быть только один — страховывает
  // частичный уникальный индекс Order_listingId_active_key (гонку двух
  // параллельных POST /orders закрывает catch P2002 ниже). Завершённые
  // заказы (REFUNDED/RELEASED) не мешают: объявление снова продаётся.
  const activeOrder = await prisma.order.findFirst({
    where: { listingId: listing.id, status: { in: [...ACTIVE_ORDER_STATUSES] } },
    select: { id: true, status: true },
  });
  if (activeOrder) {
    throw new AppError(
      errorCodes.CONFLICT,
      `По этому объявлению уже есть активный заказ (${activeOrder.status})`,
      409
    );
  }
  if (listing.status !== 'ACTIVE') {
    throw new AppError(errorCodes.CONFLICT, 'Объявление недоступно для покупки', 409);
  }
  const accountRef = sellerAccountRef(listing.seller);
  if (!accountRef || !sellerOnboarded(listing.seller)) {
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

  const hold = await provider.createHold({
    listingId: listing.id,
    listingTitle: listing.title,
    buyerId: input.buyerId,
    sellerAccountRef: accountRef,
    amountKopecks: toKopecks(amount),
    platformFeeKopecks: toKopecks(fee),
    idempotencyKey: input.idempotencyKey,
  });
  let confirmationToken: string | null = null;
  let payUrl: string | null = null;
  if (hold.anchor.type === 'confirmation_token') {
    confirmationToken = hold.anchor.token;
  } else {
    payUrl = hold.anchor.url;
  }

  const order = await prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId: input.buyerId,
      amount: listing.price,
      currency: listing.currency,
      provider: provider.name.toUpperCase() as 'YOOKASSA' | 'MONETA' | 'MOCK',
      providerPaymentId: hold.providerPaymentId,
      // Legacy-дубль на время переезда (чтение/вебхуки старых заказов).
      yookassaPaymentId: provider.name === 'yookassa' ? hold.providerPaymentId : null,
      idempotencyKey: input.idempotencyKey,
      // Срок холда известен сразу: на нём держатся предупреждения покупателя
      // (за 2 дня/за 12 часов) и перевод SHIPPED-заказа в DISPUTED.
      holdExpiresAt: new Date(Date.now() + holdTtlDays * 86_400_000),
    },
  }).catch(async (err: unknown) => {
    // Гонка двух параллельных POST /orders: второй получает 409, а не 500.
    // P2002 даёт и частичный индекс активных заказов, и idempotencyKey.
    // Созданный нами платёж отменяем, чтобы не висел сиротой-холдом.
    if (
      typeof err === 'object' && err !== null &&
      'code' in err && (err as { code?: string }).code === 'P2002'
    ) {
      await provider.cancel(hold.providerPaymentId, cancelKeyFor(input.idempotencyKey)).catch(() => undefined);
      throw new AppError(errorCodes.CONFLICT, 'По этому объявлению уже есть активный заказ', 409);
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
    await provider.cancel(hold.providerPaymentId, cancelKeyFor(input.idempotencyKey)).catch(() => undefined);
    throw new AppError(errorCodes.CONFLICT, 'Объявление недоступно для покупки', 409);
  }

  return { order, confirmationToken, payUrl, paymentId: hold.providerPaymentId };
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
  // Эскроу: release только после авторизации средств (PAID = холд удержан)
  // или после отправки товара (SHIPPED — покупатель подтвердил получение).
  // PENDING означает, что деньги ещё не удержаны — confirm упадёт у провайдера.
  if (order.status !== 'PAID' && order.status !== 'SHIPPED') {
    throw new AppError(errorCodes.CONFLICT, `Нельзя подтвердить заказ в статусе ${order.status}`, 409);
  }
  if (!order.providerPaymentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  // Атомарный переход PAID/SHIPPED -> RELEASING (тот же паттерн, что и отсчёт
  // RESERVED в createEscrowOrder): гонку двух параллельных release (и со спором:
  // dispute забирает SHIPPED -> DISPUTED) решает updateMany, а не чтение-проверка.
  // Проигравший получает 409 и не доходит до провайдера — двойной выплаты не бывает
  // даже при двух одновременных запросах.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: { in: ['PAID', 'SHIPPED'] } },
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
      text: `Покупатель подтвердил получение. Средства по сделке переведены вам.`,
    });
  }
}

/**
 * Выплата: confirm (capture) холда + финальная транзакция.
 *
 * Идемпотентность: confirm идёт с ключом `release-capture-{orderId}`
 * (единый с recovery-джобой worker'а — см. shared/constants). Если процесс
 * падает между confirm и финальной транзакцией, повторный прогон с тем же
 * ключом провайдер «дедуплицирует» и вернёт исходный результат.
 * Финальный переход RELEASING -> RELEASED дополнительно гейтится по статусу:
 * если заказ уже доведён, листинг не переворачивается повторно.
 */
export async function performRelease(order: {
  id: string;
  listingId: string;
  amount: unknown;
  currency: string;
  providerPaymentId: string | null;
  idempotencyKey: string | null;
}): Promise<void> {
  if (!order.providerPaymentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  const provider = getPaymentProvider();
  providerReady(provider);

  // Монета при release делает PaymentRequest с транзитного счёта на счёт
  // продавца — нужны реквизиты продавца и суммы. Для ЮKassa/mock transfer
  // игнорируется (пустой sellerAccountRef допустим).
  const amountNum = Number(order.amount);
  const fee = platformFeeForAmount(amountNum);
  let sellerRef: string | null = null;
  if (provider.name === 'moneta') {
    const withSeller = await prisma.order.findUnique({
      where: { id: order.id },
      include: { listing: { include: { seller: true } } },
    });
    sellerRef = withSeller?.listing.seller
      ? sellerAccountRef(withSeller.listing.seller)
      : null;
    if (!sellerRef) {
      throw new AppError(
        errorCodes.INTERNAL,
        'Монета: у продавца нет реквизитов счёта для выплаты',
        500
      );
    }
  }
  const confirmed = await provider.confirm(order.providerPaymentId, captureKeyFor(order.id), {
    sellerAccountRef: sellerRef ?? '',
    amountKopecks: toKopecks(amountNum - fee),
    platformFeeKopecks: toKopecks(fee),
  });
  if (confirmed.status !== 'captured') {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не может быть завершён', 409);
  }

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
    logger.warn({ orderId: order.id, paymentId: order.providerPaymentId }, 'release already completed by a concurrent run');
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
  // SHIPPED: товар уехал — возврат возможен только через спор (для всех,
  // включая staff: решение по спору принимается из статуса DISPUTED).
  if (order.status === 'SHIPPED') {
    throw new AppError(
      errorCodes.CONFLICT,
      'Товар уже отправлен: возврат возможен только через спор',
      409
    );
  }
  // DISPUTED: покупатель сам себе возврат не делает — решение примет
  // поддержка (refundOrder из DISPUTED — это и есть «вернуть покупателю»).
  if (isBuyer && order.status === 'DISPUTED') {
    throw new AppError(
      errorCodes.CONFLICT,
      'По заказу уже открыт спор: решение примет поддержка',
      409
    );
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
  if (!order.providerPaymentId) {
    throw new AppError(errorCodes.CONFLICT, 'Платёж не найден', 409);
  }

  // Атомарный клейм возврата (PAID/…/DISPUTED -> REFUNDING). Гонку двух
  // параллельных refundOrder решает updateMany, как у releaseOrder: проигравший
  // получает 409 и НЕ доходит до провайдера, поэтому двойного cancel/refund не бывает.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: { in: ['PENDING', 'PAID', 'DISPUTED'] } },
    data: { status: 'REFUNDING' },
  });
  if (claimed.count !== 1) {
    throw new AppError(errorCodes.CONFLICT, 'Возврат уже обрабатывается', 409);
  }

  const provider = getPaymentProvider();
  const previousStatus = order.status;
  const paymentId = order.providerPaymentId;
  try {
    const payment = await provider.getStatus(paymentId);
    if (payment.status === 'captured') {
      // Деньги уже удержаны после capture — оформляем полный возврат
      // (комиссия платформы возвращается за счёт магазина продавца).
      await provider.refund({
        providerPaymentId: paymentId,
        amountKopecks: toKopecks(order.amount),
        idempotencyKey: refundKeyFor(order.id),
      });
    } else if (payment.status === 'authorized' || payment.status === 'pending') {
      await provider.cancel(paymentId, refundCancelKeyFor(order.id)).catch(async (err) => {
        // Могли опоздать: холд истёк и провайдер уже отменил платёж сам.
        const now = await provider.getStatus(paymentId);
        if (now.status === 'canceled') return; // деньги уже вернулись покупателю
        throw err;
      });
    } else if (payment.status === 'canceled') {
      // Деньги уже вернулись покупателю (авто-отмена истёкшего холда) — идемпотентно завершаем.
      logger.info({ orderId: order.id, paymentId }, 'refund: payment already canceled');
    } else {
      throw new AppError(errorCodes.CONFLICT, 'Платёж в неподходящем статусе', 409);
    }
  } catch (err) {
    // Провайдер недоступен/отклонил — не оставляем заказ навсегда в REFUNDING:
    // возвращаем статус, с которого клеймили. Гейтим по REFUNDING, чтобы не
    // затереть параллельный переход (например, вебхук уже провёл REFUNDED).
    await prisma.order.updateMany({
      where: { id: order.id, status: 'REFUNDING' },
      data: { status: previousStatus },
    });
    logger.warn({ err, orderId: order.id }, 'refund: provider call failed, order moved back from REFUNDING');
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
 * Продавец отмечает «Отправил / передал»: PAID -> SHIPPED.
 * После отправки покупатель уже не может сделать самостоятельный возврат —
 * только спор (см. refundOrder/openDispute).
 */
export async function shipOrder(
  orderId: string,
  actorId: string,
  input: { comment?: string; trackingNumber?: string }
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      listing: { select: { sellerId: true, title: true } },
      buyer: { select: { email: true } },
    },
  });
  if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
  if (order.listing.sellerId !== actorId) {
    throw new AppError(errorCodes.FORBIDDEN, 'Отправку может отметить только продавец', 403);
  }
  if (order.status === 'SHIPPED') {
    throw new AppError(errorCodes.CONFLICT, 'Заказ уже отправлен', 409);
  }
  if (order.status !== 'PAID') {
    throw new AppError(errorCodes.CONFLICT, `Нельзя отметить отправку в статусе ${order.status}`, 409);
  }

  // Атомарный клейм PAID -> SHIPPED: гонку с release/refund/dispute решает
  // updateMany — проигравший получает 409 и не трогает статус.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: 'PAID' },
    data: {
      status: 'SHIPPED',
      shippedAt: new Date(),
      shipComment: input.comment ?? null,
      trackingNumber: input.trackingNumber ?? null,
    },
  });
  if (claimed.count !== 1) {
    throw new AppError(errorCodes.CONFLICT, 'Статус заказа уже изменился', 409);
  }

  if (order.buyer.email) {
    await enqueueEmail({
      to: order.buyer.email,
      subject: 'Продавец отправил товар',
      template: 'order-updated',
      templateData: { orderId: order.id },
      text:
        `Продавец отметил отправку товара по заказу «${order.listing.title}».` +
        (input.trackingNumber ? ` Трек-номер: ${input.trackingNumber}.` : '') +
        ' Как получите товар — подтвердите получение, и средства перейдут продавцу. ' +
        ' Если товар не пришёл — откройте спор на странице заказа.',
    }).catch((err) => logger.warn({ err, orderId: order.id }, 'ship email failed'));
  }
}

/**
 * Покупатель открывает спор: только из SHIPPED -> DISPUTED.
 * Клейм атомарный, dispute.create — в той же транзакции, чтобы не остался
 * «висящий» спор при проигранной гонке с release (SHIPPED -> RELEASING).
 */
export async function openDispute(
  orderId: string,
  actorId: string,
  input: { reason: string; comment?: string; photos?: string[] }
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      listing: { select: { sellerId: true, title: true } },
      buyer: { select: { email: true } },
    },
  });
  if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
  if (order.buyerId !== actorId) {
    throw new AppError(errorCodes.FORBIDDEN, 'Спор может открыть только покупатель', 403);
  }
  if (order.status === 'DISPUTED') {
    throw new AppError(errorCodes.CONFLICT, 'Спор по заказу уже открыт', 409);
  }
  if (order.status !== 'SHIPPED') {
    throw new AppError(
      errorCodes.CONFLICT,
      'Спор открывается после отправки товара (статус отправлен)',
      409
    );
  }

  const seller = await prisma.user.findUnique({
    where: { id: order.listing.sellerId },
    select: { email: true },
  });

  const opened = await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: 'SHIPPED' },
      data: { status: 'DISPUTED' },
    });
    if (claimed.count !== 1) return false;
    await tx.dispute.create({
      data: {
        orderId: order.id,
        openedById: actorId,
        reason: input.reason,
        comment: input.comment ?? null,
        photos: input.photos ?? [],
      },
    });
    return true;
  });
  if (!opened) {
    throw new AppError(errorCodes.CONFLICT, 'Статус заказа уже изменился, спор не открыт', 409);
  }

  const mail = {
    template: 'order-updated' as const,
    templateData: { orderId: order.id },
  };
  if (order.buyer.email) {
    await enqueueEmail({
      to: order.buyer.email,
      subject: 'Открыт спор по заказу',
      ...mail,
      text: `Вы открыли спор по заказу «${order.listing.title}». Причина: ${input.reason}. Поддержка рассмотрит заявку и пришлёт результат.`,
    }).catch((err) => logger.warn({ err, orderId: order.id }, 'dispute email (buyer) failed'));
  }
  if (seller?.email) {
    await enqueueEmail({
      to: seller.email,
      subject: 'По заказу открыт спор',
      ...mail,
      text: `Покупатель открыл спор по заказу «${order.listing.title}». Причина: ${input.reason}. Деньги удерживаются до решения поддержки.`,
    }).catch((err) => logger.warn({ err, orderId: order.id }, 'dispute email (seller) failed'));
  }
  await notifyAdmin(
    'Открыт спор по заказу',
    `Заказ ${order.id} («${order.listing.title}»): покупатель открыл спор. Причина: ${input.reason}.`
  );
}

/**
 * Решение по спору (staff): SELLER — выплата продавцу (DISPUTED -> RELEASING
 * -> capture), BUYER — возврат покупателю (refundOrder клеймит DISPUTED ->
 * REFUNDING). Оба пути атомарны, поэтому одновременные «выплатить» и
 * «вернуть» не конфликтуют: победитель закрывает спор, проигравший получает 409.
 */
export async function resolveDispute(
  orderId: string,
  staffId: string,
  role: string,
  input: { decision: 'SELLER' | 'BUYER'; comment: string }
): Promise<void> {
  const isStaff = role === 'ADMIN' || role === 'MODERATOR';
  if (!isStaff) {
    throw new AppError(errorCodes.FORBIDDEN, 'Решение по спору принимает поддержка', 403);
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      listing: { include: { seller: { select: { email: true, name: true } } } },
      buyer: { select: { email: true, name: true } },
    },
  });
  if (!order) throw new AppError(errorCodes.NOT_FOUND, 'Заказ не найден', 404);
  if (order.status !== 'DISPUTED') {
    throw new AppError(
      errorCodes.CONFLICT,
      `Нельзя закрыть спор по заказу в статусе ${order.status}`,
      409
    );
  }

  if (input.decision === 'BUYER') {
    // Возврат: внутри refundOrder — claim DISPUTED -> REFUNDING + откат
    // статуса при ошибке ЮKassa (спор остаётся открытым до успеха).
    await refundOrder(order.id, staffId, role);
  } else {
    const claimed = await prisma.order.updateMany({
      where: { id: order.id, status: 'DISPUTED' },
      data: { status: 'RELEASING' },
    });
    if (claimed.count !== 1) {
      throw new AppError(errorCodes.CONFLICT, 'Спор уже закрыт', 409);
    }
    await performRelease(order);
  }

  await prisma.dispute.updateMany({
    where: { orderId: order.id, status: 'OPEN' },
    data: {
      status: 'RESOLVED',
      resolution: input.decision,
      resolutionComment: input.comment,
      resolvedById: staffId,
      resolvedAt: new Date(),
    },
  });

  const decisionText =
    input.decision === 'SELLER'
      ? 'Решение: в пользу продавца — средства переведены продавцу.'
      : 'Решение: в пользу покупателя — средства возвращены покупателю.';
  const mail = {
    template: 'order-updated' as const,
    templateData: { orderId: order.id },
  };
  if (order.buyer.email) {
    await enqueueEmail({
      to: order.buyer.email,
      subject: 'Спор по заказу закрыт',
      ...mail,
      text: `Спор по заказу «${order.listing.title}» закрыт. ${decisionText} Комментарий поддержки: ${input.comment}`,
    }).catch((err) => logger.warn({ err, orderId: order.id }, 'resolve email (buyer) failed'));
  }
  if (order.listing.seller.email) {
    await enqueueEmail({
      to: order.listing.seller.email,
      subject: 'Спор по заказу закрыт',
      ...mail,
      text: `Спор по заказу «${order.listing.title}» закрыт. ${decisionText} Комментарий поддержки: ${input.comment}`,
    }).catch((err) => logger.warn({ err, orderId: order.id }, 'resolve email (seller) failed'));
  }
}

/**
 * Вебхук платежного провайдера. Подлинность уведомления (IP/подпись)
 * проверяет сам провайдер в handleWebhook. Здесь:
 * 1) нормализованное событие от провайдера;
 * 2) идемпотентность доставки (redis, ключ dedupeId события);
 * 3) повторный getStatus — сверка текущего статуса со статусом уведомления
 *    (отсекает устаревшие доставки);
 * 4) переходы заказа — только по providerPaymentId/orderKey.
 */
export async function handlePaymentWebhook(
  rawBody: Buffer,
  ip?: string,
  query?: Record<string, string>
): Promise<{ received: boolean; handled?: string }> {
  const provider = getPaymentProvider();
  const event = await provider.handleWebhook({ rawBody, ip, query });
  if (!event) {
    return { received: true, handled: 'ignored' };
  }

  const redis = getRedis();
  const dedupe = await redis.set(
    `payment:webhook:${provider.name}:${event.dedupeId}`,
    '1',
    'EX',
    86400,
    'NX'
  );
  if (dedupe !== 'OK') {
    return { received: true, handled: 'duplicate' };
  }

  if (event.type === 'refund') {
    const paymentId = event.providerPaymentId;
    const payment = await provider.getStatus(paymentId).catch((err) => {
      logger.warn({ err, paymentId }, 'refund webhook: payment lookup failed, skipping');
      return null;
    });
    if (!payment) return { received: true, handled: 'verification_failed' };

    const existing = await prisma.order.findFirst({
      where: { providerPaymentId: paymentId },
      select: { id: true, listingId: true, status: true },
    });
    if (!existing) return { received: true, handled: 'refund.succeeded' };

    if (existing.status === 'RELEASED' || existing.status === 'RELEASING') {
      // Деньги уже переведены продавцу (или переводятся): платформа получила
      // возврат средств продавца, но «авто-возврат» покупателю тут запрещён —
      // иначе сумма спишется дважды. Статус не трогаем, уведомляем админа.
      logger.warn({
        orderId: existing.id, paymentId, refundId: event.providerRefundId, status: existing.status,
      }, 'refund after pay-out; manual resolution required');
      await notifyAdmin(
        'Возврат по уже выплаченной сделке',
        `Возврат ${event.providerRefundId ?? '?'} по платежу ${paymentId}. ` +
          `Заказ ${existing.id} уже переведён продавцу (статус ${existing.status}): ` +
          `возврат покупателю оформите вручную в кабинете платежного провайдера.`
      );
      return { received: true, handled: 'refund.succeeded' };
    }

    const marked = await prisma.order.updateMany({
      where: { providerPaymentId: paymentId, status: { notIn: ['REFUNDED', 'RELEASING', 'RELEASED', 'DISPUTED'] } },
      data: { status: 'REFUNDED' },
    });
    if (marked.count > 0) {
      const target = await prisma.order.findFirst({
        where: { providerPaymentId: paymentId },
        select: { listingId: true },
      });
      if (target) await unlockListing(target.listingId);
      logger.info({ orderId: existing.id, paymentId, refundId: event.providerRefundId }, 'payment refunded via webhook');
    }
    return { received: true, handled: 'refund.succeeded' };
  }

  // Платёжное событие: сверяем статус повторным запросом к провайдеру.
  const paymentId = event.providerPaymentId;
  const payment = await provider.getStatus(paymentId).catch((err) => {
    logger.warn({ err, paymentId }, 'payment webhook: lookup failed, skipping');
    return null;
  });
  if (!payment || (event.notifiedStatus && payment.status !== event.notifiedStatus)) {
    // Устаревшая/повторная доставка: статус в уведомлении не совпал с текущим.
    logger.warn(
      { paymentId, notified: event.notifiedStatus, currentStatus: payment?.status },
      'webhook status mismatch, skipping'
    );
    return { received: true, handled: 'stale' };
  }

  const orderKey = payment.orderKey;
  switch (payment.status) {
    case 'authorized': {
      // Эскроу: средства авторизованы и удерживаются платформой.
      if (orderKey) {
        await prisma.order.updateMany({
          where: { idempotencyKey: orderKey, status: 'PENDING' },
          data: { status: 'PAID' },
        });
      }
      break;
    }
    case 'captured': {
      // Captured наступает ПОСЛЕ confirm в releaseOrder (или вручную из
      // кабинета провайдера). Никогда не делаем авто-RELEASE без подтверждения
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
        where: { providerPaymentId: paymentId, status: { in: ['PAID', 'DISPUTED', 'SHIPPED'] } },
        data: { status: 'REFUNDED' },
      });
      if (held.count > 0) {
        const target = await prisma.order.findFirst({
          where: { providerPaymentId: paymentId },
          select: { listingId: true },
        });
        if (target) await unlockListing(target.listingId);
      }
      break;
    }
    default:
      break;
  }
  return { received: true, handled: event.dedupeId };
}

/**
 * Legacy-алиас для существующих тестов/вызовов. Основное имя — handlePaymentWebhook.
 */
export const handleYookassaNotification = handlePaymentWebhook;