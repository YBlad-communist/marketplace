/**
 * Провайдер-независимый интерфейс платежей (эскроу «безопасная сделка»).
 *
 * Все суммы на границе провайдера — целые копейки (Kopecks). Конвертация
 * в формат провайдера (строковые рубли у ЮKassa, поля Монеты) — внутри
 * конкретного провайдера. Статусы нормализованы: провайдер-специфичные
 * значения (waiting_for_capture и т.п.) не просачиваются за пределы слоя.
 */

export type PaymentProviderName = 'yookassa' | 'moneta' | 'mock';

/**
 * Нормализованный статус платежа:
 * - pending    — создан, средства ещё не удержаны;
 * - authorized — холд: средства удержаны и ждут подтверждения («безопасная сделка»);
 * - captured   — подтверждены (средства распределены/доступны к выплате);
 * - canceled   — отменён, деньги у покупателя;
 * - refunded   — возврат после capture;
 * - unknown    — провайдер вернул незнакомый статус (не трогаем заказ).
 */
export type NormalizedPaymentStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'canceled'
  | 'refunded'
  | 'unknown';

/** Сумма в копейках (целое число). */
export type Kopecks = number;

/**
 * «Платёжный якорь» для фронта:
 * - confirmation_token — виджет ЮKassa (CheckoutModal);
 * - pay_url — редирект на страницу оплаты (Монета, Pay URL).
 */
export type PaymentAnchor =
  | { type: 'confirmation_token'; token: string }
  | { type: 'pay_url'; url: string };

export interface PaymentProviderOrderInput {
  /** Наш заказ (id) — если уже создан; на момент createHold часто ещё нет. */
  orderId?: string;
  listingId: string;
  listingTitle: string;
  buyerId: string;
  /**
   * Реквизит продавца у провайдера: Shop ID магазина (ЮKassa),
   * MNT_ACCOUNT_ID расширенного счёта (Монета). null — продавец не подключён
   * (paymentService проверяет до вызова createHold).
   */
  sellerAccountRef: string | null;
  amountKopecks: Kopecks;
  platformFeeKopecks: Kopecks;
  /** Идемпотентный ключ создания (наш idempotencyKey заказа). */
  idempotencyKey: string;
}

export interface CreateHoldResult {
  providerPaymentId: string;
  anchor: PaymentAnchor;
  status: NormalizedPaymentStatus;
}

export interface PaymentStatusResult {
  providerPaymentId: string;
  status: NormalizedPaymentStatus;
  /**
   * Наш ключ заказа (idempotencyKey), сохранённый у провайдера в metadata:
   * ЮKassa — metadata.orderKey, Монета — MNT_ORDER_ID. Используется
   * paymentService для поиска заказа по вебхуку/статусу.
   */
  orderKey?: string;
  /**
   * Якорь для фронта, если провайдер может вернуть его повторным запросом
   * (ЮKassa отдаёт confirmation_token живого платежа). Нужен для повторного
   * открытия оплаты по существующему idempotencyKey заказа.
   */
  anchor?: PaymentAnchor;
}

export interface PaymentConfirmResult {
  providerPaymentId: string;
  status: NormalizedPaymentStatus;
}

export interface PaymentCancelResult {
  providerPaymentId: string;
  status: NormalizedPaymentStatus;
}

export interface PaymentRefundResult {
  providerRefundId: string;
  providerPaymentId: string;
  status: NormalizedPaymentStatus;
}

/**
 * Нормализованное событие вебхука провайдера. Провайдер только разбирает
 * уведомление и проверяет его подлинность (подпись/IP); сверку статуса с
 * текущим платежом (повторный getStatus) и переходы заказа выполняет
 * paymentService — как и раньше для ЮKassa.
 */
export interface NormalizedPaymentWebhookEvent {
  type: 'payment' | 'refund';
  /** Платёж, о котором сообщает провайдер. */
  providerPaymentId: string;
  /** Для type='refund' — id возврата у провайдера. */
  providerRefundId?: string;
  /**
   * Нормализованный статус из уведомления (для сверки «устарело?»):
   * paymentService сравнивает его с текущим getStatus() и отсекает
   * устаревшие доставки. Для refund-событий — не заполняется.
   */
  notifiedStatus?: NormalizedPaymentStatus;
  /**
   * Уникальный ключ доставки уведомления (повторная доставка того же
   * уведомления = тот же ключ). ЮKassa: `${event}:${payment/refund id}`,
   * Монета: MNT_TRANSACTION_ID + результат. Идемпотентность webhook'ов
   * строится на этом ключе в redis.
   */
  dedupeId: string;
}

export interface SellerOnboardingField {
  name: string;
  label: string;
  placeholder?: string;
  help?: string;
}

/** Описание «как подключить выплаты» — без привязки к провайдеру в UI. */
export interface SellerOnboardingInfo {
  fields: SellerOnboardingField[];
  /** Шаги простым языком. */
  steps: string[];
  /** Подпись кнопки/формы (например, «Подключить выплаты»). */
  actionLabel: string;
}

/**
 * Детали перевода при confirm. ЮKassa: transfers настраиваются на createHold,
 * здесь игнорируются. Монета (безопасная сделка): при release выполняется
 * PaymentRequest с транзитного счёта площадки на расширенный счёт продавца.
 */
export interface PaymentConfirmTransfer {
  sellerAccountRef: string;
  /** Сумма продавцу (итог минус комиссия) в копейках. */
  amountKopecks: Kopecks;
  /** Комиссия платформы в копейках (остаётся на транзитном счёте). */
  platformFeeKopecks: Kopecks;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;

  /** Провайдер настроен (ключи/аккаунт заданы). false — операции падают с понятной ошибкой. */
  isConfigured(): boolean;

  /** Удержание средств (холд) по заказу. */
  createHold(input: PaymentProviderOrderInput): Promise<CreateHoldResult>;

  /**
   * Подтверждение холда (capture) — «деньги продавцу».
   * transfer — реквизиты перевода (нужны Монете; ЮKassa/mock игнорируют).
   */
  confirm(
    providerPaymentId: string,
    idempotencyKey: string,
    transfer?: PaymentConfirmTransfer
  ): Promise<PaymentConfirmResult>;

  /** Отмена холда — деньги возвращаются покупателю (до capture). */
  cancel(providerPaymentId: string, idempotencyKey: string): Promise<PaymentCancelResult>;

  /** Возврат после capture (полный). */
  refund(input: {
    providerPaymentId: string;
    amountKopecks: Kopecks;
    idempotencyKey: string;
  }): Promise<PaymentRefundResult>;

  /** Текущий статус платежа (сверка в вебхуках и worker-джобах). */
  getStatus(providerPaymentId: string): Promise<PaymentStatusResult>;

  /**
   * Разбор уведомления провайдера (rawBody от провайдера). Подлинность
   * проверяет сам провайдер (401 при нарушении). Возвращает нормализованное
   * событие или null, если уведомление не о платежах/возвратах.
   * query — параметры URL для GET-уведомлений (Монета Pay URL).
   */
  handleWebhook(input: {
    rawBody: Buffer;
    ip?: string;
    query?: Record<string, string>;
  }): Promise<NormalizedPaymentWebhookEvent | null>;

  /** Тексты/поля для страницы «Подключение выплат» (/seller/connect). */
  getSellerOnboardingInfo(): SellerOnboardingInfo;
}
