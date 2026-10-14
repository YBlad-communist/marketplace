import { AppError, errorCodes, type NormalizedPaymentStatus } from '@marketplace/shared';
import type {
  CreateHoldResult,
  NormalizedPaymentWebhookEvent,
  PaymentCancelResult,
  PaymentConfirmResult,
  PaymentProvider,
  PaymentProviderOrderInput,
  PaymentRefundResult,
  PaymentStatusResult,
  SellerOnboardingInfo,
} from '@marketplace/shared';
import {
  cancelKeyFor,
  cancelYookassaPayment,
  captureYookassaPayment,
  createYookassaPayment,
  getYookassaPayment,
  isTrustedYookassaIp,
  refundYookassaPayment,
  toAmount,
  yookassaConfigured,
} from './yookassa.js';
import { paymentEnv } from './env.js';
import { paymentsLogger as logger } from './logger.js';

/**
 * Статусы ЮKassa → нормализованные. Всё, что не из списка, — 'unknown'.
 */
const YOO_STATUS_MAP: Record<string, NormalizedPaymentStatus> = {
  pending: 'pending',
  waiting_for_capture: 'authorized',
  succeeded: 'captured',
  canceled: 'canceled',
};

export function normalizeYooStatus(status: string): NormalizedPaymentStatus {
  return YOO_STATUS_MAP[status] ?? 'unknown';
}

/**
 * Провайдер ЮKassa: split payments + двухстадийный платёж.
 * Бизнес-стейт-машина заказов — в слое-потребителе; провайдер знает только
 * о платеже у ЮKassa.
 */
export class YooKassaProvider implements PaymentProvider {
  readonly name = 'yookassa' as const;

  isConfigured(): boolean {
    return yookassaConfigured();
  }

  async createHold(input: PaymentProviderOrderInput): Promise<CreateHoldResult> {
    if (!input.sellerAccountRef) {
      throw new AppError(errorCodes.PAYMENT_REQUIRED, 'Продавец не подключил выплаты', 402);
    }
    const amount = input.amountKopecks / 100;
    const fee = input.platformFeeKopecks / 100;
    const sellerAmount = Number((amount - fee).toFixed(2));

    const payment = await createYookassaPayment({
      amount,
      description: `Оплата заказа на платформе (объявление: ${input.listingTitle})`,
      metadata: {
        orderKey: input.idempotencyKey,
        listingId: input.listingId,
        buyerId: input.buyerId,
      },
      transfers: [
        {
          account_id: input.sellerAccountRef,
          amount: toAmount(sellerAmount),
          platform_fee_amount: toAmount(fee),
          description: `Выплата за объявление «${input.listingTitle}».`,
        },
      ],
      idempotencyKey: input.idempotencyKey,
    });

    const token = payment.confirmation?.confirmation_token;
    if (!token) {
      await cancelYookassaPayment(payment.id, cancelKeyFor(input.idempotencyKey)).catch(() => undefined);
      throw new AppError(errorCodes.INTERNAL, 'ЮKassa не выдала токен виджета', 502);
    }

    return {
      providerPaymentId: payment.id,
      anchor: { type: 'confirmation_token', token },
      status: normalizeYooStatus(payment.status),
    };
  }

  async confirm(
    providerPaymentId: string,
    idempotencyKey: string,
    _transfer?: unknown
  ): Promise<PaymentConfirmResult> {
    // transfer (Монета: PaymentRequest продавцу) у ЮKassa не нужен —
    // transfers настраиваются на createHold.
    const payment = await captureYookassaPayment(providerPaymentId, idempotencyKey);
    return { providerPaymentId, status: normalizeYooStatus(payment.status) };
  }

  async cancel(providerPaymentId: string, idempotencyKey: string): Promise<PaymentCancelResult> {
    const payment = await cancelYookassaPayment(providerPaymentId, idempotencyKey);
    return { providerPaymentId, status: normalizeYooStatus(payment.status) };
  }

  async refund(input: {
    providerPaymentId: string;
    amountKopecks: number;
    idempotencyKey: string;
  }): Promise<PaymentRefundResult> {
    const refund = await refundYookassaPayment(
      input.providerPaymentId,
      input.amountKopecks / 100,
      input.idempotencyKey
    );
    return {
      providerRefundId: refund.id,
      providerPaymentId: input.providerPaymentId,
      status: 'refunded',
    };
  }

  async getStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    const payment = await getYookassaPayment(providerPaymentId);
    const token = payment.confirmation?.confirmation_token;
    return {
      providerPaymentId,
      status: normalizeYooStatus(payment.status),
      orderKey: payment.metadata?.orderKey,
      anchor: token ? { type: 'confirmation_token', token } : undefined,
    };
  }

  /**
   * Вебхук ЮKassa: подлинность — по IP-аллоулисту (или INSECURE_WEBHOOKS
   * для разработки). Сверка статуса повторным GET и переходы заказа —
   * в paymentService (как раньше).
   */
  async handleWebhook(input: { rawBody: Buffer; ip?: string; query?: Record<string, string> }): Promise<NormalizedPaymentWebhookEvent | null> {
    if (!paymentEnv.YOOKASSA_INSECURE_WEBHOOKS && (!input.ip || !isTrustedYookassaIp(input.ip))) {
      logger.warn({ ip: input.ip }, 'yookassa webhook from untrusted ip');
      throw new AppError(errorCodes.UNAUTHORIZED, 'Неизвестный отправитель уведомления', 401);
    }

    let body: { type?: string; event?: string; object?: unknown };
    try {
      body = JSON.parse(input.rawBody.toString('utf8')) as typeof body;
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

    if (event === 'refund.succeeded') {
      const paymentId = object.payment_id;
      if (!paymentId) return null;
      return {
        type: 'refund',
        providerPaymentId: paymentId,
        providerRefundId: String(object.id),
        dedupeId: `${event}:${String(object.id)}`,
      };
    }

    return {
      type: 'payment',
      providerPaymentId: String(object.id),
      notifiedStatus: object.status ? normalizeYooStatus(String(object.status)) : undefined,
      dedupeId: `${event}:${String(object.id)}`,
    };
  }

  getSellerOnboardingInfo(): SellerOnboardingInfo {
    return {
      fields: [
        {
          name: 'shopId',
          label: 'Shop ID магазина ЮKassa',
          placeholder: '123456',
          help: 'Личный кабинет ЮKassa → магазин → «Настройки». Магазин должен пройти модерацию.',
        },
      ],
      steps: [
        'Зарегистрируйтесь в личном кабинете ЮKassa (yookassa.ru) и создайте магазин.',
        'Пройдите модерацию магазина и включите для него приём платежей.',
        'Скопируйте Shop ID магазина и укажите его здесь.',
      ],
      actionLabel: 'Подключить выплаты',
    };
  }
}
