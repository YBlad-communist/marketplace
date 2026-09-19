import { AppError, errorCodes, expiredHoldCancelIdempotencyKey, refundCancelIdempotencyKey, refundIdempotencyKey, releaseCaptureIdempotencyKey } from '@marketplace/shared';
import { env } from '../config.js';
import { logger } from './logger.js';

/**
 * Клиент API ЮKassa (split payments для платформ, двухстадийные платежи).
 *
 * Эскроу-паттерн: создаём платёж с capture:false и confirmation embedded —
 * деньги авторизуются и удерживаются (status: pending -> waiting_for_capture),
 * capture переводит покупателю/продавцам деньги, cancel возвращает холд.
 * Сплитование: transfers[] задают долю продавца (account_id) и комиссию
 * платформы (platform_fee_amount); при capture ЮKassa сама раскладывает сумму.
 *
 * Идемпотентность: обязательный заголовок Idempotence-Key (≤64 симв., дедуп 24ч)
 * — ключи едины для paymentService и worker-рекавери (см. shared/constants).
 */

export const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';

export const YOOKASSA_NOTIFICATION_IP_RANGES = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '2a02:5180::/32',
] as const;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/**
 * Проверка IP отправителя уведомления по официальному аллоулисту ЮKassa.
 * Уведомления не подписаны, поэтому это первая линия защиты; вторая —
 * повторный GET статуса платежа (см. handleYookassaNotification).
 */
export function isTrustedYookassaIp(ip: string): boolean {
  const candidate = ip.trim();
  if (!candidate) return false;
  // IPv4-в-IPv6 (::ffff:1.2.3.4) приводим к IPv4.
  const mapped = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const normalized = mapped ? mapped[1] : candidate;

  if (normalized.includes(':')) {
    const candidateHextets = normalized
      .toLowerCase()
      .replace(/::.*$/, '')
      .split(':')
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
    return YOOKASSA_NOTIFICATION_IP_RANGES.some((range) => {
      if (!range.includes(':')) return false; // IPv4-диапазон не подходит
      const rangeHextets = range
        .toLowerCase()
        .replace(/::.*$/, '')
        .split(':')
        .filter(Boolean)
        .map((h) => parseInt(h, 16));
      return rangeHextets.every((h, i) => candidateHextets[i] === h);
    });
  }

  const target = ipv4ToInt(normalized);
  if (target === null) return false;
  return YOOKASSA_NOTIFICATION_IP_RANGES.some((range) => {
    const m = range.match(/^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/);
    if (!m) return false;
    const base = ipv4ToInt(m[1]);
    if (base === null) return false;
    const prefix = m[2] ? Number(m[2]) : 32;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (target & mask) === (base & mask);
  });
}

export interface YooAmount {
  value: string;
  currency: string;
}

export type YooPaymentStatus =
  | 'pending'
  | 'waiting_for_capture'
  | 'succeeded'
  | 'canceled'
  | 'refunded';

export interface YooPaymentTransfer {
  account_id: string;
  amount: YooAmount;
  platform_fee_amount?: YooAmount;
  description?: string;
  metadata?: Record<string, string>;
}

export interface YooPayment {
  id: string;
  status: YooPaymentStatus | string;
  paid: boolean;
  amount: YooAmount;
  refundable: boolean;
  refunded_amount?: YooAmount;
  capture?: boolean;
  confirmation?: { type: 'embedded' | 'redirect'; confirmation_token?: string; confirmation_url?: string };
  metadata?: Record<string, string>;
  transfers?: { account_id: string; amount: YooAmount; platform_fee_amount?: YooAmount }[];
}

export interface YooRefund {
  id: string;
  status: string;
  payment_id: string;
  amount: YooAmount;
}

export function toAmount(value: number): YooAmount {
  return { value: value.toFixed(2), currency: 'RUB' };
}

export function numberFromAmount(amount: YooAmount): number {
  return Number(amount.value);
}

interface YooRequestOptions {
  idempotencyKey?: string;
}

export function yookassaConfigured(): boolean {
  return Boolean(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY);
}

async function yookassaFetch<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts?: YooRequestOptions
): Promise<T> {
  if (!yookassaConfigured()) {
    throw new AppError(errorCodes.INTERNAL, 'ЮKassa не настроена', 500);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`).toString('base64')}`,
  };
  if (opts?.idempotencyKey) {
    headers['Idempotence-Key'] = opts.idempotencyKey.slice(0, 64);
  }
  const res = await fetch(`${YOOKASSA_API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & {
    type?: string;
    code?: string;
    description?: string;
  };
  if (!res.ok) {
    // 4xx/5xx ЮKassa: description содержит понятную причину (например,
    // incorrect_status -> платёж уже отменён/возвращён). Прокидываем наружу,
    // чтобы слой-потребитель решал, как обработать.
    const message = (json as { description?: string }).description ?? `ЮKassa: HTTP ${res.status}`;
    logger.warn({ method, path, status: res.status, code: json.code }, 'yookassa api error');
    throw new AppError(errorCodes.INTERNAL, message, 502);
  }
  return json as T;
}

/** Создание двухстадийного сплит-платежа c confirmation embedded (виджет). */
export async function createYookassaPayment(input: {
  amount: number;
  description: string;
  metadata: Record<string, string>;
  transfers: YooPaymentTransfer[];
  idempotencyKey: string;
}): Promise<YooPayment> {
  return yookassaFetch<YooPayment>(
    'POST',
    '/payments',
    {
      amount: toAmount(input.amount),
      capture: false,
      confirmation: { type: 'embedded' },
      description: input.description.slice(0, 128),
      metadata: input.metadata,
      transfers: input.transfers,
    },
    { idempotencyKey: input.idempotencyKey }
  );
}

/** Текущий статус платежа (используется для сверки в вебхуках и джобах). */
export async function getYookassaPayment(paymentId: string): Promise<YooPayment> {
  return yookassaFetch<YooPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
}

/**
 * Capture в полном объёме. Сплит уже задан при создании платежа, поэтому тело
 * передачи пустое — ЮKassa раскладывает деньги продавцам по transfers сразу.
 */
export async function captureYookassaPayment(paymentId: string, idempotencyKey: string): Promise<YooPayment> {
  return yookassaFetch<YooPayment>(
    'POST',
    `/payments/${encodeURIComponent(paymentId)}/capture`,
    {},
    { idempotencyKey }
  );
}

/** Отмена холда (только для pending/waiting_for_capture): деньги возвращаются покупателю. */
export async function cancelYookassaPayment(paymentId: string, idempotencyKey: string): Promise<YooPayment> {
  return yookassaFetch<YooPayment>(
    'POST',
    `/payments/${encodeURIComponent(paymentId)}/cancel`,
    {},
    { idempotencyKey }
  );
}

/**
 * Полный возврат. Без `sources` и `platform_fee_amount` комиссия платформы
 * возвращается за счёт магазинов продавцов — то же, что и при холде.
 */
export async function refundYookassaPayment(paymentId: string, amount: number, idempotencyKey: string): Promise<YooRefund> {
  return yookassaFetch<YooRefund>(
    'POST',
    '/refunds',
    { payment_id: paymentId, amount: toAmount(amount) },
    { idempotencyKey }
  );
}

/** Идемпотентные ключи для операций над конкретным заказом (едины с worker). */
export function captureKeyFor(orderId: string): string {
  return releaseCaptureIdempotencyKey(orderId);
}
export function refundCancelKeyFor(orderId: string): string {
  return refundCancelIdempotencyKey(orderId);
}
export function refundKeyFor(orderId: string): string {
  return refundIdempotencyKey(orderId);
}
export function expiredCancelKeyFor(orderId: string): string {
  return expiredHoldCancelIdempotencyKey(orderId);
}
/** Ключ отмены сироты-платежа (если заказ не был создан из-за гонки/резерва). */
export function cancelKeyFor(orderKey: string): string {
  return `yookassa-orphan-cancel-${orderKey}`.slice(0, 64);
}