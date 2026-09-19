/**
 * Минимальный клиент ЮKassa для worker-джоб (без зависимости от API).
 * Джобы только сверяются со статусом платежа, доводят capture и отменяют холды.
 * Идемпотентные ключи те же, что в API (совместно shared/constants).
 */

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';

export interface YooAmount {
  value: string;
  currency: string;
}

export interface YooPayment {
  id: string;
  status: string;
  paid?: boolean;
  amount?: YooAmount;
  metadata?: Record<string, string>;
}

interface Client {
  shopId: string;
  secretKey: string;
}

let client: Client | null = null;

export function configureYookassa(shopId: string, secretKey: string): void {
  client = shopId && secretKey ? { shopId, secretKey } : null;
}

export function yookassaConfigured(): boolean {
  return Boolean(client);
}

async function yookassaFetch<T>(method: 'GET' | 'POST', path: string, idempotencyKey?: string): Promise<T> {
  if (!client) throw new Error('yookassa not configured');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`${client.shopId}:${client.secretKey}`).toString('base64')}`,
  };
  if (idempotencyKey) headers['Idempotence-Key'] = idempotencyKey.slice(0, 64);
  const res = await fetch(`${YOOKASSA_API_URL}${path}`, { method, headers });
  if (!res.ok) throw new Error(`yookassa http ${res.status}`);
  return (await res.json()) as T;
}

export function getYookassaPayment(paymentId: string): Promise<YooPayment> {
  return yookassaFetch<YooPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
}

export function captureYookassaPayment(paymentId: string, idempotencyKey: string): Promise<YooPayment> {
  return yookassaFetch<YooPayment>(
    'POST',
    `/payments/${encodeURIComponent(paymentId)}/capture`,
    idempotencyKey
  );
}

export function cancelYookassaPayment(paymentId: string, idempotencyKey: string): Promise<YooPayment> {
  return yookassaFetch<YooPayment>(
    'POST',
    `/payments/${encodeURIComponent(paymentId)}/cancel`,
    idempotencyKey
  );
}