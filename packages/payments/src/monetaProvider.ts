import { timingSafeEqual } from 'node:crypto';
import { AppError, errorCodes } from '@marketplace/shared';
import type {
  CreateHoldResult,
  NormalizedPaymentWebhookEvent,
  PaymentCancelResult,
  PaymentConfirmResult,
  PaymentConfirmTransfer,
  PaymentProvider,
  PaymentProviderOrderInput,
  PaymentRefundResult,
  PaymentStatusResult,
  SellerOnboardingInfo,
} from '@marketplace/shared';
import {
  buildAssistantPayUrl,
  monetaAmount,
  monetaCancelTransaction,
  monetaConfigured,
  monetaFindByCtid,
  monetaGetOperation,
  monetaNotificationSignature,
  monetaRefund,
  monetaTransferToSeller,
  normalizeMonetaStatus,
} from './moneta.js';
import { paymentEnv } from './env.js';
import { paymentsLogger as logger } from './logger.js';

/**
 * Провайдер Монеты (docs.moneta.ru). Безопасная сделка маркетплейса:
 * 1) createHold — платёжная форма Assistant на транзитный счёт площадки
 *    (якорь pay_url; providerPaymentId = MNT_TRANSACTION_ID = idempotencyKey,
 *    реальный номер операции МОНЕТА.РУ подтягивается FindOperationsListByCTID);
 * 2) confirm — PaymentRequest с транзитного счёта на расширенный счёт продавца
 *    (PARENTID = базовая операция платежа);
 * 3) cancel — CancelTransaction незавершённой операции;
 * 4) refund — RefundRequest по операции;
 * 5) вебхук Pay URL (GET/POST, MNT_SIGNATURE по формулам docs.moneta.ru);
 *    сверка статуса повторным FindOperations — в paymentService.
 */
export class MonetaProvider implements PaymentProvider {
  readonly name = 'moneta' as const;

  isConfigured(): boolean {
    return monetaConfigured();
  }

  async createHold(input: PaymentProviderOrderInput): Promise<CreateHoldResult> {
    if (!input.sellerAccountRef) {
      throw new AppError(errorCodes.PAYMENT_REQUIRED, 'Продавец не подключил выплаты', 402);
    }
    return {
      providerPaymentId: input.idempotencyKey,
      anchor: {
        type: 'pay_url',
        url: this.buildPayUrl(input.idempotencyKey, input.amountKopecks, input.listingTitle),
      },
      status: 'pending',
    };
  }

  /** Платёжная форма Assistant. CTID = наш idempotencyKey заказа. */
  private buildPayUrl(ctid: string, amountKopecks: number, listingTitle?: string): string {
    return buildAssistantPayUrl({
      transactionId: ctid,
      amountRub: monetaAmount(amountKopecks / 100),
      description: listingTitle
        ? `Оплата заказа на платформе (объявление: ${listingTitle})`
        : undefined,
    });
  }

  /** Резолвит CTID (idempotencyKey) → операцию Монеты. null — ещё не оплачено. */
  private async resolveOperation(providerPaymentId: string) {
    const op = await monetaFindByCtid(providerPaymentId);
    if (!op || !Number.isFinite(op.id)) return null;
    return op;
  }

  async confirm(
    providerPaymentId: string,
    idempotencyKey: string,
    transfer?: PaymentConfirmTransfer
  ): Promise<PaymentConfirmResult> {
    if (!transfer?.sellerAccountRef) {
      throw new AppError(errorCodes.INTERNAL, 'Монета: confirm требует реквизиты продавца', 500);
    }
    // П.4: режим выплат. card/npd пока не поддержаны Монетой через Merchant API.
    // TODO: Реализовать выплаты на карту (card) и по НПД (npd), когда Монета
    // поддержит их. См. docs.moneta.ru — раздел «Выплаты»:
    // https://docs.moneta.ru/solutions/marketplaces/
    if (transfer.payoutMode && transfer.payoutMode !== 'account') {
      throw new AppError(
        errorCodes.PAYMENT_REQUIRED,
        `Режим выплат «${transfer.payoutMode}» не настроен у провайдера Монета. ` +
          'Временно доступен только перевод на расширенный счёт (account).',
        402
      );
    }
    const op = await this.resolveOperation(providerPaymentId);
    if (!op) {
      throw new AppError(errorCodes.CONFLICT, 'Операция Монеты не найдена (платёж не проведён)', 409);
    }
    const normalized = normalizeMonetaStatus(op.statusId);
    if (normalized === 'canceled') {
      return { providerPaymentId, status: 'canceled' };
    }
    if (normalized !== 'authorized' && normalized !== 'captured') {
      throw new AppError(
        errorCodes.CONFLICT,
        `Подтвердить можно только удержание (статус Монеты: ${op.statusId})`,
        409
      );
    }

    // Уже переведено? Повторный release идемпотентен по clientTransaction.
    const already = await monetaFindByCtid(idempotencyKey);
    if (already && normalizeMonetaStatus(already.statusId) === 'captured') {
      return { providerPaymentId, status: 'captured' };
    }

    const result = await monetaTransferToSeller({
      parentOperationId: op.id,
      sellerAccountRef: transfer.sellerAccountRef,
      amountRub: monetaAmount(transfer.amountKopecks / 100),
      clientTransaction: idempotencyKey,
    });
    const status = normalizeMonetaStatus(result.statusId);
    // PaymentRequest может вернуть INPROGRESS — для release это успех
    // (перевод принят); финальный SUCCEED подтянет вебхук/worker.
    if (status === 'canceled' || status === 'unknown') {
      throw new AppError(
        errorCodes.CONFLICT,
        `Перевод продавцу не проведён (статус: ${result.statusId})`,
        409
      );
    }
    logger.info(
      { operationId: result.id, ctid: idempotencyKey, status: result.statusId },
      'moneta: transfer to seller accepted'
    );
    return { providerPaymentId, status: 'captured' };
  }

  async cancel(providerPaymentId: string, idempotencyKey: string): Promise<PaymentCancelResult> {
    const op = await this.resolveOperation(providerPaymentId);
    if (!op) {
      // Покупатель не успел оплатить форму — отменять нечего.
      return { providerPaymentId, status: 'canceled' };
    }
    const normalized = normalizeMonetaStatus(op.statusId);
    if (normalized === 'canceled') {
      return { providerPaymentId, status: 'canceled' };
    }
    if (normalized === 'authorized' || normalized === 'captured') {
      // Деньги уже на транзите/у продавца — авто-отмена запрещена (как у ЮKassa
      // по succeeded): нужен refund, его делает refundOrder.
      throw new AppError(
        errorCodes.CONFLICT,
        `Операция уже проведена (${op.statusId}) — используйте возврат`,
        409
      );
    }
    await monetaCancelTransaction(op.id, idempotencyKey);
    return { providerPaymentId, status: 'canceled' };
  }

  async refund(input: {
    providerPaymentId: string;
    amountKopecks: number;
    idempotencyKey: string;
  }): Promise<PaymentRefundResult> {
    const op = await this.resolveOperation(input.providerPaymentId);
    if (!op) {
      throw new AppError(errorCodes.CONFLICT, 'Операция Монеты не найдена', 409);
    }
    const result = await monetaRefund({
      operationId: op.id,
      amountRub: monetaAmount(input.amountKopecks / 100),
      clientTransaction: input.idempotencyKey,
      description: 'Возврат по заказу площадки',
    });
    return {
      providerRefundId: String(result.id),
      providerPaymentId: input.providerPaymentId,
      status: 'refunded',
    };
  }

  async getStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    // providerPaymentId = CTID (idempotencyKey). Если пришёл числовой id операции
    // (обновили после вебхука) — берём GetOperationDetailsById.
    if (/^\d+$/.test(providerPaymentId)) {
      const op = await monetaGetOperation(Number(providerPaymentId));
      return {
        providerPaymentId,
        status: normalizeMonetaStatus(op.statusId),
        orderKey: op.clientTransaction,
        amountKopecks: op.amount ? Math.round(Number(op.amount) * 100) : undefined,
      };
    }
    const op = await this.resolveOperation(providerPaymentId);
    if (!op) {
      // Операции ещё нет (покупатель не оплачивал) — без якоря; повторную
      // ссылку на форму paymentService собирает при необходимости.
      return { providerPaymentId, status: 'pending', orderKey: providerPaymentId };
    }
    return {
      providerPaymentId,
      status: normalizeMonetaStatus(op.statusId),
      orderKey: op.clientTransaction ?? providerPaymentId,
      amountKopecks: op.amount ? Math.round(Number(op.amount) * 100) : undefined,
    };
  }

  /**
   * Вебхук Pay URL (docs.moneta.ru/payments/payment-notification).
   * GET или POST с MNT_ID, MNT_TRANSACTION_ID, MNT_OPERATION_ID, MNT_AMOUNT,
   * MNT_CURRENCY_CODE, MNT_TEST_MODE, MNT_SIGNATURE.
   * Подлинность — MNT_SIGNATURE (формула из доков, см. monetaNotificationSignature).
   * Уведомление не содержит статус — notifiedStatus не заполняется, paymentService
   * сверит через getStatus. Ответ SUCCESS шлёт роут сам (после нормализации).
   */
  async handleWebhook(input: {
    rawBody: Buffer;
    ip?: string;
    query?: Record<string, string>;
  }): Promise<NormalizedPaymentWebhookEvent | null> {
    let params: Record<string, string> = { ...(input.query ?? {}) };

    // POST (application/x-www-form-urlencoded или query в rawBody).
    const raw = input.rawBody.toString('utf8').trim();
    if (raw) {
      if (raw.startsWith('{')) {
        throw new AppError(errorCodes.VALIDATION, 'Ожидалось уведомление Монеты (MNT_* fields)', 400);
      }
      const usp = new URLSearchParams(raw);
      for (const [k, v] of usp.entries()) params[k] = v;
    }

    const mntId = params.MNT_ID;
    const transactionId = params.MNT_TRANSACTION_ID;
    const operationId = params.MNT_OPERATION_ID;
    const signature = params.MNT_SIGNATURE;
    if (!mntId || !transactionId || !signature) {
      throw new AppError(errorCodes.VALIDATION, 'Некорректное уведомление Монеты', 400);
    }

    if (!monetaConfigured()) {
      throw new AppError(errorCodes.INTERNAL, 'Монета не настроена', 500);
    }
    if (mntId !== paymentEnv.MONETA_ACCOUNT_ID) {
      logger.warn({ mntId }, 'moneta webhook: unknown MNT_ID');
      throw new AppError(errorCodes.UNAUTHORIZED, 'Чужой счёт в уведомлении', 401);
    }

    const expected = monetaNotificationSignature({
      mntId,
      transactionId,
      operationId,
      amount: params.MNT_AMOUNT ?? '',
      currency: params.MNT_CURRENCY_CODE ?? '',
      subscriberId: params.MNT_SUBSCRIBER_ID,
      testMode: params.MNT_TEST_MODE ?? '0',
      checkCode: paymentEnv.MONETA_ACCOUNT_CODE!,
    });
    // Аудит: сравнение через timingSafeEqual (буферы одинаковой длины),
    // чтобы не утечь время сравнения при подборе подписи.
    // Коды могут приходить в upper/lower hex — сравниваем без регистра.
    const sigBuf = Buffer.from(signature.toLowerCase(), 'utf8');
    const expBuf = Buffer.from(expected.toLowerCase(), 'utf8');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      logger.warn({ transactionId }, 'moneta webhook: bad MNT_SIGNATURE');
      throw new AppError(errorCodes.UNAUTHORIZED, 'Неверная подпись уведомления', 401);
    }

    if (!operationId) {
      logger.warn({ transactionId }, 'moneta webhook: no MNT_OPERATION_ID');
      return null;
    }

    // Dedupe: MNT_OPERATION_ID стабильный для одной операции; повторные
    // доставки за 24ч имеют тот же ключ. providerPaymentId = CTID
    // (MNT_TRANSACTION_ID) — то же, что сохранено при createHold.
    return {
      type: 'payment',
      providerPaymentId: transactionId,
      dedupeId: `moneta:${operationId}:${params.MNT_TEST_MODE ?? '0'}`,
    };
  }

  getSellerOnboardingInfo(): SellerOnboardingInfo {
    return {
      fields: [
        {
          name: 'accountId',
          label: 'Номер расширенного счёта Монета',
          placeholder: '12345678',
          help: 'Личный кабинет moneta.ru → расширенный счёт продавца (Монета открывает ИП/ЮЛ).',
        },
      ],
      steps: [
        'Зарегистрируйтесь в Монете (moneta.ru) и откройте расширенный счёт (ИП/ЮЛ).',
        'Пройдите проверку профиля продавца.',
        'Скопируйте номер расширенного счёта и укажите его здесь.',
      ],
      actionLabel: 'Подключить выплаты',
    };
  }
}
