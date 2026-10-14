import { createHash } from 'node:crypto';
import { AppError, errorCodes, type NormalizedPaymentStatus } from '@marketplace/shared';
import { paymentEnv } from './env.js';
import { paymentsLogger as logger } from './logger.js';

/**
 * Низкоуровневый клиент Монеты (docs.moneta.ru).
 *  - Assistant (платёжная форма): MNT_* + MNT_SIGNATURE = MD5(concat + код проверки).
 *  - MerchantAPI (JSON-конверт, Service URL https://service.moneta.ru/services):
 *    ConfirmTransaction / CancelTransaction / Payment / Refund / FindOperationsListByCTID.
 * Секреты только в env; в логи не попадают.
 */

export function monetaConfigured(): boolean {
  return Boolean(paymentEnv.MONETA_ACCOUNT_ID && paymentEnv.MONETA_ACCOUNT_CODE);
}

/** Сумма в рублях с двумя знаками — формат MNT_AMOUNT и подписи. */
export function monetaAmount(rubles: number): string {
  return rubles.toFixed(2);
}

/**
 * MNT_SIGNATURE Assistant: MD5(MNT_ID + MNT_TRANSACTION_ID + MNT_AMOUNT +
 * MNT_CURRENCY_CODE + MNT_SUBSCRIBER_ID + ТЕСТОВЫЙ_РЕЖИМ + КОД_ПРОВЕРКИ).
 * MNT_SUBSCRIBER_ID пуст, если не задан. См. docs.moneta.ru/assistant/v1/payment-request.
 */
export function monetaFormSignature(params: {
  mntId: string;
  transactionId: string;
  amount: string;
  currency: string;
  subscriberId?: string;
  testMode: boolean;
  checkCode: string;
}): string {
  const raw =
    params.mntId +
    params.transactionId +
    params.amount +
    params.currency +
    (params.subscriberId ?? '') +
    (params.testMode ? '1' : '0') +
    params.checkCode;
  return createHash('md5').update(raw, 'utf8').digest('hex');
}

/**
 * Подпись уведомления Pay URL (docs.moneta.ru, Assistant §уведомления):
 * MNT_SIGNATURE = MD5(MNT_ID + MNT_TRANSACTION_ID + MNT_OPERATION_ID +
 * MNT_AMOUNT + MNT_CURRENCY_CODE + MNT_SUBSCRIBER_ID + MNT_TEST_MODE +
 * код проверки целостности данных).
 * Пример из доков: md5(54600817FF790ABCD123456120.25RUB0QWERTY).
 */
export function monetaNotificationSignature(params: {
  mntId: string;
  transactionId: string;
  operationId: string;
  amount: string;
  currency: string;
  subscriberId?: string;
  testMode: string;
  checkCode: string;
}): string {
  const raw =
    params.mntId +
    params.transactionId +
    params.operationId +
    params.amount +
    params.currency +
    (params.subscriberId ?? '') +
    params.testMode +
    params.checkCode;
  return createHash('md5').update(raw, 'utf8').digest('hex');
}

/** Ссылка/форма Assistant для оплаты (якорь pay_url). */
export function buildAssistantPayUrl(params: {
  transactionId: string;
  amountRub: string;
  description?: string;
  successUrl?: string;
  failUrl?: string;
}): string {
  if (!monetaConfigured()) {
    throw new AppError(errorCodes.INTERNAL, 'Монета не настроена (MONETA_ACCOUNT_ID/CODE)', 500);
  }
  const testMode = paymentEnv.MONETA_TEST_MODE ? '1' : '0';
  const signature = monetaFormSignature({
    mntId: paymentEnv.MONETA_ACCOUNT_ID!,
    transactionId: params.transactionId,
    amount: params.amountRub,
    currency: 'RUB',
    testMode: paymentEnv.MONETA_TEST_MODE,
    checkCode: paymentEnv.MONETA_ACCOUNT_CODE!,
  });
  const q = new URLSearchParams({
    MNT_ID: paymentEnv.MONETA_ACCOUNT_ID!,
    MNT_TRANSACTION_ID: params.transactionId,
    MNT_AMOUNT: params.amountRub,
    MNT_CURRENCY_CODE: 'RUB',
    MNT_TEST_MODE: testMode,
    MNT_SIGNATURE: signature,
  });
  if (params.description) q.set('MNT_DESCRIPTION', params.description.slice(0, 500));
  if (params.successUrl) q.set('MNT_SUCCESS_URL', params.successUrl);
  if (params.failUrl) q.set('MNT_FAIL_URL', params.failUrl);
  return `${paymentEnv.MONETA_ASSISTANT_URL}?${q.toString()}`;
}

/** Статусы MerchantAPI statusid → нормализованные. */
const MONETA_STATUS_MAP: Record<string, NormalizedPaymentStatus> = {
  CREATED: 'pending',
  INPROGRESS: 'pending',
  // Средства списаны/зачислены на транзитный счёт площадки, но ещё не
  // распределены продавцу — удержание (эскроу).
  TAKENOUT: 'authorized',
  TAKENIN_NOTSENT: 'authorized',
  FROZEN: 'authorized',
  // Базовая операция «зачислена» — деньги у площадки на транзите.
  SUCCEED: 'authorized',
  CANCELED: 'canceled',
};

export function normalizeMonetaStatus(statusId: string): NormalizedPaymentStatus {
  return MONETA_STATUS_MAP[statusId] ?? 'unknown';
}

export interface MonetaOperation {
  id: number;
  statusId: string;
  clientTransaction?: string;
  amount?: string;
  raw: Record<string, unknown>;
}

interface MonetaSoapFault {
  faultstring?: string;
  faultcode?: string;
  detail?: unknown;
}

/**
 * Вызов MerchantAPI (JSON-конверт Envelope/Header/Body, docs.moneta.ru/protocols).
 * Аутентификация — UsernameToken (логин/пароль ЛК).
 */
export async function monetaMerchantCall<T>(
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  if (!paymentEnv.MONETA_API_USERNAME || !paymentEnv.MONETA_API_PASSWORD) {
    throw new AppError(errorCodes.INTERNAL, 'Монета: не заданы MONETA_API_USERNAME/PASSWORD', 500);
  }
  const payload = {
    Envelope: {
      Header: {
        Security: {
          UsernameToken: {
            Username: paymentEnv.MONETA_API_USERNAME,
            Password: paymentEnv.MONETA_API_PASSWORD,
          },
        },
      },
      Body: { [method]: body },
    },
  };

  const res = await fetch(paymentEnv.MONETA_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(payload),
  }).catch((err: unknown) => {
    logger.warn({ err, method }, 'moneta merchantapi request failed');
    throw new AppError(errorCodes.INTERNAL, 'Монета недоступна', 502);
  });

  const text = await res.text();
  let json: {
    Envelope?: {
      Body?: Record<string, unknown> & { Fault?: MonetaSoapFault };
    };
  };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    logger.warn({ method, status: res.status }, 'moneta merchantapi: non-json response');
    throw new AppError(errorCodes.INTERNAL, 'Монета: некорректный ответ API', 502);
  }

  const bodyOut = json.Envelope?.Body;
  // JSON-ошибки MerchantAPI: HTTP 400 и Body.fault (docs: «JSON конверт»).
  const fault =
    (bodyOut?.Fault as MonetaSoapFault | undefined) ??
    (bodyOut?.fault as MonetaSoapFault | undefined);
  if (!res.ok || fault) {
    logger.warn({ method, status: res.status, fault }, 'moneta merchantapi fault');
    throw new AppError(
      errorCodes.INTERNAL,
      `Монета: ${fault?.faultstring ?? `ошибка ${res.status}`}`,
      502
    );
  }

  // Ответ: FindOperationsListByCTIDResponse / PaymentResponse / …
  // (имя = запрос без «Request» + «Response»); иногда — под исходным именем метода.
  const base = method.replace(/Request$/, '');
  const result =
    bodyOut?.[`${base}Response`] ??
    bodyOut?.[`${method}Response`] ??
    bodyOut?.[method];
  if (result === undefined) {
    logger.warn({ method, keys: bodyOut ? Object.keys(bodyOut) : [] }, 'moneta merchantapi: empty body');
    throw new AppError(errorCodes.INTERNAL, 'Монета: пустой ответ API', 502);
  }
  return result as T;
}

/** Атрибуты OperationInfo из ответа MerchantAPI. */
function operationAttributes(op: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  const attrs = op.attribute ?? op.attributes;
  if (Array.isArray(attrs)) {
    for (const a of attrs as Array<{ key?: string; value?: string }>) {
      if (a?.key != null) map.set(String(a.key).toLowerCase(), String(a.value ?? ''));
    }
  }
  return map;
}

function parseOperation(op: Record<string, unknown>): MonetaOperation {
  const attrs = operationAttributes(op);
  const id = Number(op.id ?? op.transaction ?? op.transactionId ?? attrs.get('id') ?? NaN);
  const statusId =
    String(op.statusid ?? attrs.get('statusid') ?? attrs.get('status') ?? 'UNKNOWN').toUpperCase();
  const clientTransaction =
    (op.clientTransaction as string | undefined) ?? attrs.get('clienttransaction');
  return {
    id: Number.isFinite(id) ? id : NaN,
    statusId,
    clientTransaction,
    amount: (op.amount as string | undefined) ?? attrs.get('amount'),
    raw: op,
  };
}

/**
 * FindOperationsListByCTID: поиск операций по внешнему номеру (MNT_TRANSACTION_ID).
 * По внешнему номеру может найтись несколько операций — берём последнюю.
 */
export async function monetaFindByCtid(ctid: string): Promise<MonetaOperation | null> {
  if (!paymentEnv.MONETA_ACCOUNT_ID) {
    throw new AppError(errorCodes.INTERNAL, 'Монета: не задан MONETA_ACCOUNT_ID', 500);
  }
  const resp = await monetaMerchantCall<Record<string, unknown>>('FindOperationsListByCTIDRequest', {
    accountId: paymentEnv.MONETA_ACCOUNT_ID,
    clientTransaction: ctid,
  });

  // Ответ: { operation: [...] } или { operation: {...} } или { list: { operation: [...] } }
  const list =
    (resp.operation as unknown) ??
    (resp as { list?: { operation?: unknown } }).list?.operation ??
    [];
  const ops = (Array.isArray(list) ? list : [list]).filter(
    (o): o is Record<string, unknown> => typeof o === 'object' && o !== null
  );
  if (ops.length === 0) return null;

  const parsed = ops.map(parseOperation).filter((o) => Number.isFinite(o.id));
  if (parsed.length === 0) return null;
  // Последняя операция по списку (самая свежая).
  return parsed[parsed.length - 1];
}

export async function monetaGetOperation(operationId: number): Promise<MonetaOperation> {
  const resp = await monetaMerchantCall<Record<string, unknown>>(
    'GetOperationDetailsByIdRequest',
    { transactionId: operationId }
  );
  const op = (resp.operation ?? resp) as Record<string, unknown>;
  return parseOperation(op);
}

/**
 * Подтверждение холда (безопасная сделка): PaymentRequest с транзитного
 * счёта площадки на расширенный счёт продавца. PARENTID — базовая операция
 * платежа (docs.moneta.ru/solutions/marketplaces/payments/secure).
 */
export async function monetaTransferToSeller(input: {
  parentOperationId: number;
  sellerAccountRef: string;
  amountRub: string;
  clientTransaction: string;
}): Promise<MonetaOperation> {
  if (!paymentEnv.MONETA_TRANSIT_ACCOUNT) {
    throw new AppError(errorCodes.INTERNAL, 'Монета: не задан MONETA_TRANSIT_ACCOUNT', 500);
  }
  if (!paymentEnv.MONETA_PAYMENT_PASSWORD) {
    throw new AppError(errorCodes.INTERNAL, 'Монета: не задан MONETA_PAYMENT_PASSWORD', 500);
  }
  const resp = await monetaMerchantCall<Record<string, unknown>>('PaymentRequest', {
    payer: paymentEnv.MONETA_TRANSIT_ACCOUNT,
    payee: input.sellerAccountRef,
    amount: input.amountRub,
    clientTransaction: input.clientTransaction,
    paymentPassword: paymentEnv.MONETA_PAYMENT_PASSWORD,
    operationInfo: {
      attribute: [{ key: 'PARENTID', value: String(input.parentOperationId) }],
    },
  });
  return parseOperation(resp);
}

/** Отмена незавершённой операции (снятие холда до capture). */
export async function monetaCancelTransaction(
  operationId: number,
  clientTransaction?: string
): Promise<MonetaOperation> {
  const body: Record<string, unknown> = { transactionId: operationId };
  if (clientTransaction) body.clientTransaction = clientTransaction;
  const resp = await monetaMerchantCall<Record<string, unknown>>('CancelTransactionRequest', body);
  return parseOperation(resp);
}

/**
 * Возврат по операции (RefundRequest). transactionId — номер операции в
 * МОНЕТА.РУ; amount — необязательная сумма (рубли, строка).
 */
export async function monetaRefund(input: {
  operationId: number;
  amountRub?: string;
  clientTransaction: string;
  description?: string;
}): Promise<MonetaOperation> {
  const body: Record<string, unknown> = {
    transactionId: input.operationId,
    clientTransaction: input.clientTransaction,
  };
  if (input.amountRub) body.amount = input.amountRub;
  if (input.description) body.description = input.description.slice(0, 500);
  const resp = await monetaMerchantCall<Record<string, unknown>>('RefundRequest', body);
  return parseOperation(resp);
}
