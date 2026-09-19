import { vi } from 'vitest';

/**
 * Мок ЮKassa на уровне глобального fetch. Мокаем именно сеть (а не SDK),
 * поэтому вся логика paymentService остаётся настоящей: статусные переходы,
 * идемпотентные ключи, обработка ошибок проверяются по-честному.
 */

export interface FakeYooPayment {
  id: string;
  status: string;
  paid: boolean;
  amount: { value: string; currency: string };
  refundable: boolean;
  refunded_amount?: { value: string; currency: string };
  capture: boolean;
  confirmation: { type: string; confirmation_token: string };
  metadata: Record<string, string>;
  transfers?: unknown[];
}

export interface YookassaFake {
  payments: Map<string, FakeYooPayment>;
  calls: {
    create: number;
    capture: number;
    cancel: number;
    refund: number;
    get: number;
    capturedIds: string[];
    canceledIds: string[];
    refundedIds: string[];
  };
  fetchMock: ReturnType<typeof vi.fn>;
  lastPaymentId(): string;
  setPaymentStatus(paymentId: string, status: string): void;
  setCreateStatus(status: string): void;
  reset(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function installYookassaFake(options?: {
  createStatus?: string;
  captureStatus?: string;
}): YookassaFake {
  const payments = new Map<string, FakeYooPayment>();
  // Уникальный префикс на каждый install: тест-файлы идут параллельно и делят
  // одну БД, поэтому id платежей не должны совпадать между ними.
  const runId = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  let createStatus = options?.createStatus ?? 'pending';
  const captureStatus = options?.captureStatus ?? 'succeeded';

  const calls: YookassaFake['calls'] = {
    create: 0,
    capture: 0,
    cancel: 0,
    refund: 0,
    get: 0,
    capturedIds: [],
    canceledIds: [],
    refundedIds: [],
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : {};

    if (url.endsWith('/payments') && method === 'POST') {
      const id = `yoo_pay_${runId}_${++seq}`;
      const payment: FakeYooPayment = {
        id,
        status: createStatus,
        paid: false,
        amount: body.amount as FakeYooPayment['amount'],
        refundable: false,
        capture: Boolean(body.capture),
        confirmation: { type: 'embedded', confirmation_token: `tok_${id}` },
        metadata: (body.metadata as Record<string, string>) ?? {},
        transfers: body.transfers as unknown[],
      };
      payments.set(id, payment);
      calls.create += 1;
      return json(payment);
    }

    if (url.endsWith('/refunds') && method === 'POST') {
      const paymentId = String(body.payment_id);
      const payment = payments.get(paymentId);
      if (!payment) return json({ code: 'not_found', description: 'payment not found' }, 404);
      calls.refund += 1;
      calls.refundedIds.push(paymentId);
      payment.refundable = false;
      payment.refunded_amount = body.amount as FakeYooPayment['amount'];
      return json({
        id: `yoo_refund_${calls.refund}`,
        status: 'succeeded',
        payment_id: paymentId,
        amount: body.amount,
      });
    }

    const captureMatch = url.match(/\/payments\/([^/]+)\/capture$/);
    if (captureMatch && method === 'POST') {
      const id = captureMatch[1];
      const payment = payments.get(id);
      if (!payment) return json({ code: 'not_found', description: 'payment not found' }, 404);
      calls.capture += 1;
      calls.capturedIds.push(id);
      payment.status = captureStatus;
      payment.paid = true;
      payment.refundable = true;
      return json(payment);
    }

    const cancelMatch = url.match(/\/payments\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const id = cancelMatch[1];
      const payment = payments.get(id);
      if (!payment) return json({ code: 'not_found', description: 'payment not found' }, 404);
      calls.cancel += 1;
      calls.canceledIds.push(id);
      payment.status = 'canceled';
      payment.paid = false;
      return json(payment);
    }

    const getMatch = url.match(/\/payments\/([^/?]+)(?:\?|$)/);
    if (getMatch && method === 'GET') {
      const id = getMatch[1];
      const payment = payments.get(id);
      calls.get += 1;
      if (!payment) return json({ code: 'not_found', description: 'payment not found' }, 404);
      return json(payment);
    }

    return json({ code: 'not_found', description: `unknown route ${method} ${url}` }, 404);
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    payments,
    calls,
    fetchMock,
    lastPaymentId: () => {
      const ids = Array.from(payments.keys());
      return ids[ids.length - 1] ?? '';
    },
    setPaymentStatus: (paymentId, status) => {
      const payment = payments.get(paymentId);
      if (payment) {
        payment.status = status;
        payment.paid = status === 'succeeded';
        payment.refundable = status === 'succeeded';
      }
    },
    setCreateStatus: (status) => {
      createStatus = status;
    },
    reset: () => {
      payments.clear();
      calls.create = 0;
      calls.capture = 0;
      calls.cancel = 0;
      calls.refund = 0;
      calls.get = 0;
      calls.capturedIds = [];
      calls.canceledIds = [];
      calls.refundedIds = [];
    },
  };
}
