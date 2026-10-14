import { randomUUID } from 'node:crypto';
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
import { paymentsLogger as logger } from './logger.js';

interface MockPayment {
  status: NormalizedPaymentStatus;
  amountKopecks: number;
  orderKey: string;
  refunds: string[];
}

/**
 * Тестовый/девелоперский провайдер без сети и секретов.
 *
 * Состояние живёт в памяти процесса: перезапуск процесса «забывает»
 * платежи — для дев-окружения и vitest это приемлемо, для прода не
 * предназначен (в проде провайдер — yookassa или moneta).
 *
 * Управление в тестах: mockPaymentProvider() → payments.set(...),
 * чтобы перевести платёж в нужный статус перед вызовом release/refund.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  readonly payments = new Map<string, MockPayment>();

  isConfigured(): boolean {
    return true;
  }

  async createHold(input: PaymentProviderOrderInput): Promise<CreateHoldResult> {
    if (!input.sellerAccountRef) {
      throw new AppError(errorCodes.PAYMENT_REQUIRED, 'Продавец не подключил выплаты', 402);
    }
    const id = `mock_pay_${randomUUID()}`;
    this.payments.set(id, {
      status: 'authorized',
      amountKopecks: input.amountKopecks,
      orderKey: input.idempotencyKey,
      refunds: [],
    });
    return {
      providerPaymentId: id,
      anchor: { type: 'confirmation_token', token: `mock_token_${id}` },
      status: 'authorized',
    };
  }

  private mustGet(id: string): MockPayment {
    const payment = this.payments.get(id);
    if (!payment) {
      throw new AppError(errorCodes.NOT_FOUND, `Мок-платёж ${id} не найден`, 404);
    }
    return payment;
  }

  async confirm(
    providerPaymentId: string,
    _idempotencyKey: string,
    _transfer?: unknown
  ): Promise<PaymentConfirmResult> {
    const payment = this.mustGet(providerPaymentId);
    if (payment.status !== 'authorized' && payment.status !== 'captured') {
      throw new AppError(errorCodes.CONFLICT, `Подтвердить можно только холд (сейчас: ${payment.status})`, 409);
    }
    payment.status = 'captured';
    return { providerPaymentId, status: payment.status };
  }

  async cancel(providerPaymentId: string, _idempotencyKey: string): Promise<PaymentCancelResult> {
    const payment = this.mustGet(providerPaymentId);
    if (payment.status === 'canceled') return { providerPaymentId, status: 'canceled' };
    if (payment.status !== 'pending' && payment.status !== 'authorized') {
      throw new AppError(errorCodes.CONFLICT, `Отменить нельзя (сейчас: ${payment.status})`, 409);
    }
    payment.status = 'canceled';
    return { providerPaymentId, status: payment.status };
  }

  async refund(input: {
    providerPaymentId: string;
    amountKopecks: number;
    idempotencyKey: string;
  }): Promise<PaymentRefundResult> {
    const payment = this.mustGet(input.providerPaymentId);
    if (payment.status !== 'captured') {
      throw new AppError(errorCodes.CONFLICT, `Возврат возможен только после capture (сейчас: ${payment.status})`, 409);
    }
    const refundId = `mock_refund_${randomUUID()}`;
    payment.refunds.push(refundId);
    payment.status = 'refunded';
    return {
      providerRefundId: refundId,
      providerPaymentId: input.providerPaymentId,
      status: payment.status,
    };
  }

  async getStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    const payment = this.mustGet(providerPaymentId);
    return {
      providerPaymentId,
      status: payment.status,
      orderKey: payment.orderKey,
      anchor: { type: 'confirmation_token', token: `mock_token_${providerPaymentId}` },
    };
  }

  /**
   * Уведомление мока — JSON вида
   * { "providerPaymentId": "mock_pay_...", "type": "payment" | "refund", "providerRefundId": "..." }.
   * Подлинность не проверяется (это mock; в проде — провайдер с подписью/IP).
   */
  async handleWebhook(input: { rawBody: Buffer; ip?: string; query?: Record<string, string> }): Promise<NormalizedPaymentWebhookEvent | null> {
    let body: { providerPaymentId?: string; type?: string; providerRefundId?: string; dedupeId?: string };
    try {
      body = JSON.parse(input.rawBody.toString('utf8')) as typeof body;
    } catch {
      throw new AppError(errorCodes.VALIDATION, 'Некорректное тело уведомления', 400);
    }
    if (!body.providerPaymentId) {
      throw new AppError(errorCodes.VALIDATION, 'Нет providerPaymentId', 400);
    }
    logger.info({ providerPaymentId: body.providerPaymentId, type: body.type }, 'mock webhook');
    return {
      type: body.type === 'refund' ? 'refund' : 'payment',
      providerPaymentId: body.providerPaymentId,
      providerRefundId: body.providerRefundId,
      dedupeId: body.dedupeId ?? `mock:${randomUUID()}`,
    };
  }

  getSellerOnboardingInfo(): SellerOnboardingInfo {
    return {
      fields: [
        {
          name: 'accountRef',
          label: 'Идентификатор продавца (мок)',
          placeholder: 'seller-1',
          help: 'Тестовый провайдер: любое непустое значение.',
        },
      ],
      steps: ['Это тестовый платёжный провайдер (mock). Укажите любое значение.'],
      actionLabel: 'Подключить (mock)',
    };
  }
}

/** Singleton-доступ для тестов (управление статусами платежей). */
let mockSingleton: MockPaymentProvider | null = null;
export function createMockPaymentProvider(): MockPaymentProvider {
  mockSingleton = new MockPaymentProvider();
  return mockSingleton;
}
export function mockPaymentProvider(): MockPaymentProvider {
  if (!mockSingleton) mockSingleton = new MockPaymentProvider();
  return mockSingleton;
}
