import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@marketplace/db';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { handlePaymentWebhook } from '../src/services/paymentService.js';
import { resetPaymentProviderForTests } from '../src/services/payments/index.js';
import { monetaNotificationSignature } from '../src/lib/moneta.js';
import { isInfraAvailable } from './helpers.js';

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const ACCOUNT_ID = '54600817';
const ACCOUNT_CODE = 'auditcode1';
const originalEnv = { ...process.env };

// Операции Монеты: ctid -> { amount, operationId }.
const operations = new Map<string, { amount: string; operationId: string }>();

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (!url.includes('service.moneta.ru')) {
    return new Response('{}', { status: 404 });
  }
  const envelope = JSON.parse(init?.body as string) as {
    Envelope: { Body: Record<string, Record<string, unknown>> };
  };
  const methodName = Object.keys(envelope.Envelope.Body)[0];
  if (methodName === 'FindOperationsListByCTIDRequest') {
    const ctid = String(
      (envelope.Envelope.Body[methodName] as Record<string, unknown>).clientTransaction
    );
    const op = operations.get(ctid);
    if (!op) {
      return new Response(JSON.stringify({ Envelope: { Body: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        Envelope: {
          Body: {
            FindOperationsListByCTIDResponse: {
              operation: {
                id: op.operationId,
                statusid: 'TAKENOUT',
                clientTransaction: ctid,
                amount: op.amount,
              },
            },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return new Response(JSON.stringify({ Envelope: { Body: {} } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

function buildWebhookBody(ctid: string, amountRub: string, operationId: string): Buffer {
  const sig = monetaNotificationSignature({
    mntId: ACCOUNT_ID,
    transactionId: ctid,
    operationId,
    amount: amountRub,
    currency: 'RUB',
    testMode: '0',
    checkCode: ACCOUNT_CODE,
  });
  const params = new URLSearchParams({
    MNT_ID: ACCOUNT_ID,
    MNT_TRANSACTION_ID: ctid,
    MNT_OPERATION_ID: operationId,
    MNT_AMOUNT: amountRub,
    MNT_CURRENCY_CODE: 'RUB',
    MNT_TEST_MODE: '0',
    MNT_SIGNATURE: sig,
  });
  return Buffer.from(params.toString(), 'utf8');
}

const unique = Date.now();
let buyerId = '';
let sellerId = '';
let categoryId = '';

async function makeOrder(amount: number, ctid: string): Promise<string> {
  const listing = await prisma.listing.create({
    data: {
      title: `Товар amount-${ctid}`,
      description: 'Описание',
      price: amount,
      categoryId,
      city: 'Москва',
      sellerId,
      status: 'ACTIVE',
    },
  });
  const order = await prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      amount,
      currency: 'RUB',
      provider: 'MONETA',
      providerPaymentId: ctid,
      idempotencyKey: ctid,
      status: 'PENDING',
    },
  });
  return order.id;
}

beforeAll(async () => {
  await connectRedis();
  vi.stubGlobal('fetch', fetchMock);
  process.env.PAYMENT_PROVIDER = 'moneta';
  process.env.MONETA_ACCOUNT_ID = ACCOUNT_ID;
  process.env.MONETA_ACCOUNT_CODE = ACCOUNT_CODE;
  process.env.MONETA_API_USERNAME = 'testuser';
  process.env.MONETA_API_PASSWORD = 'testpass';
  process.env.MONETA_TEST_MODE = 'false';
  resetPaymentProviderForTests();

  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  categoryId = cat?.id ?? '';

  const bPhone = `+7${unique.toString().slice(-9)}8`;
  buyerId = (
    await prisma.user.create({
      data: { name: 'Buyer-amount', phone: bPhone, passwordHash: 'x' },
    })
  ).id;
  const sPhone = `+7${unique.toString().slice(-9)}9`;
  sellerId = (
    await prisma.user.create({
      data: {
        name: 'Seller-amount',
        phone: sPhone,
        passwordHash: 'x',
        payoutAccountId: '12345',
        payoutOnboarded: true,
      },
    })
  ).id;
});

afterAll(async () => {
  // Восстанавливаем env и провайдера, чтобы не отравить другие файлы.
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetPaymentProviderForTests();
  vi.unstubAllGlobals();
  await disconnectRedis();
});

beforeEach(() => {
  operations.clear();
  fetchMock.mockClear();
});

describeInfra('п.2: сверка суммы Монеты (op.amount) с order.amount', () => {
  it('расхождение суммы: заказ НЕ переводится в PAID', async () => {
    const ctid = `amt-mismatch-${unique}`;
    const opId = String(881000 + (unique % 100000));
    // Заказ на 100 ₽, провайдер сообщает 90 ₽.
    operations.set(ctid, { amount: '90.00', operationId: opId });
    const orderId = await makeOrder(100, ctid);

    const body = buildWebhookBody(ctid, '90.00', opId);
    const result = await handlePaymentWebhook(body);
    expect(result.received).toBe(true);
    expect(result.handled).not.toBe('duplicate');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING');
  });

  it('совпадение суммы: заказ переводится в PAID', async () => {
    const ctid = `amt-match-${unique}`;
    const opId = String(991000 + (unique % 100000));
    operations.set(ctid, { amount: '100.00', operationId: opId });
    const orderId = await makeOrder(100, ctid);

    const body = buildWebhookBody(ctid, '100.00', opId);
    const result = await handlePaymentWebhook(body);
    expect(result.received).toBe(true);
    expect(result.handled).not.toBe('duplicate');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');
  });
});
