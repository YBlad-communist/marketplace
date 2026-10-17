import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AppError } from '@marketplace/shared';

// Мокаем сетевой слой Монеты; сигнатурные функции остаются настоящими.
vi.mock('../src/moneta.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/moneta.js')>();
  return {
    ...actual,
    monetaFindByCtid: vi.fn(),
    monetaGetOperation: vi.fn(),
    monetaTransferToSeller: vi.fn(),
  };
});

import {
  monetaFindByCtid,
  monetaTransferToSeller,
  monetaNotificationSignature,
} from '../src/moneta.js';
import { MonetaProvider } from '../src/monetaProvider.js';

const ACCOUNT_ID = '54600817';
const ACCOUNT_CODE = 'QWERTY123';

function signedBody(params: Record<string, string>): Buffer {
  const search = new URLSearchParams(params);
  return Buffer.from(search.toString(), 'utf8');
}

function makeSignature(overrides?: Partial<Parameters<typeof monetaNotificationSignature>[0]>): string {
  return monetaNotificationSignature({
    mntId: ACCOUNT_ID,
    transactionId: 'ctid-1',
    operationId: '100',
    amount: '100.00',
    currency: 'RUB',
    testMode: '0',
    checkCode: ACCOUNT_CODE,
    ...overrides,
  });
}

describe('п.1: подпись вебхука Монеты — timingSafeEqual + MNT_SUBSCRIBER_ID', () => {
  const provider = new MonetaProvider();

  beforeEach(() => {
    process.env.MONETA_ACCOUNT_ID = ACCOUNT_ID;
    process.env.MONETA_ACCOUNT_CODE = ACCOUNT_CODE;
    process.env.MONETA_TEST_MODE = 'false';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('валидная подпись проходит (возвращает событие)', async () => {
    const sig = makeSignature();
    const body = signedBody({
      MNT_ID: ACCOUNT_ID,
      MNT_TRANSACTION_ID: 'ctid-1',
      MNT_OPERATION_ID: '100',
      MNT_AMOUNT: '100.00',
      MNT_CURRENCY_CODE: 'RUB',
      MNT_TEST_MODE: '0',
      MNT_SIGNATURE: sig,
    });
    const event = await provider.handleWebhook({ rawBody: body });
    expect(event).not.toBeNull();
    expect(event?.providerPaymentId).toBe('ctid-1');
    expect(event?.dedupeId).toBe('moneta:100:0');
  });

  it('невалидная подпись -> 401 (timingSafeEqual)', async () => {
    const body = signedBody({
      MNT_ID: ACCOUNT_ID,
      MNT_TRANSACTION_ID: 'ctid-1',
      MNT_OPERATION_ID: '100',
      MNT_AMOUNT: '100.00',
      MNT_CURRENCY_CODE: 'RUB',
      MNT_TEST_MODE: '0',
      MNT_SIGNATURE: 'deadbeefdeadbeefdeadbeefdeadbeef',
    });
    await expect(provider.handleWebhook({ rawBody: body })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('подпись другой длины -> 401 (не падает на timingSafeEqual)', async () => {
    const body = signedBody({
      MNT_ID: ACCOUNT_ID,
      MNT_TRANSACTION_ID: 'ctid-1',
      MNT_OPERATION_ID: '100',
      MNT_AMOUNT: '100.00',
      MNT_CURRENCY_CODE: 'RUB',
      MNT_TEST_MODE: '0',
      MNT_SIGNATURE: 'abc',
    });
    await expect(provider.handleWebhook({ rawBody: body })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('MNT_SUBSCRIBER_ID учитывается в подписи: валидная с subscriberId проходит', async () => {
    const sig = makeSignature({ subscriberId: 'sub42' });
    const body = signedBody({
      MNT_ID: ACCOUNT_ID,
      MNT_TRANSACTION_ID: 'ctid-1',
      MNT_OPERATION_ID: '100',
      MNT_AMOUNT: '100.00',
      MNT_CURRENCY_CODE: 'RUB',
      MNT_SUBSCRIBER_ID: 'sub42',
      MNT_TEST_MODE: '0',
      MNT_SIGNATURE: sig,
    });
    const event = await provider.handleWebhook({ rawBody: body });
    expect(event).not.toBeNull();
  });

  it('MNT_SUBSCRIBER_ID: подпись без subscriberId -> 401', async () => {
    // Подпись посчитана БЕЗ subscriberId, но в уведомлении он есть —
    // expected включает subscriberId -> не совпадает.
    const sig = makeSignature();
    const body = signedBody({
      MNT_ID: ACCOUNT_ID,
      MNT_TRANSACTION_ID: 'ctid-1',
      MNT_OPERATION_ID: '100',
      MNT_AMOUNT: '100.00',
      MNT_CURRENCY_CODE: 'RUB',
      MNT_SUBSCRIBER_ID: 'sub42',
      MNT_TEST_MODE: '0',
      MNT_SIGNATURE: sig,
    });
    await expect(provider.handleWebhook({ rawBody: body })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('подпись без subscriberId (нет в уведомлении) проходит', async () => {
    const sig = makeSignature();
    const body = signedBody({
      MNT_ID: ACCOUNT_ID,
      MNT_TRANSACTION_ID: 'ctid-1',
      MNT_OPERATION_ID: '100',
      MNT_AMOUNT: '100.00',
      MNT_CURRENCY_CODE: 'RUB',
      MNT_TEST_MODE: '0',
      MNT_SIGNATURE: sig,
    });
    const event = await provider.handleWebhook({ rawBody: body });
    expect(event).not.toBeNull();
  });
});

describe('п.2: getStatus возвращает amountKopecks', () => {
  const provider = new MonetaProvider();

  beforeEach(() => {
    process.env.MONETA_ACCOUNT_ID = ACCOUNT_ID;
    process.env.MONETA_ACCOUNT_CODE = ACCOUNT_CODE;
    vi.mocked(monetaFindByCtid).mockReset();
  });

  it('op.amount "90.50" -> amountKopecks 9050', async () => {
    vi.mocked(monetaFindByCtid).mockResolvedValue({
      id: 100,
      statusId: 'TAKENOUT',
      clientTransaction: 'ctid-1',
      amount: '90.50',
      raw: {},
    });
    const result = await provider.getStatus('ctid-1');
    expect(result.amountKopecks).toBe(9050);
    expect(result.status).toBe('authorized');
    expect(result.orderKey).toBe('ctid-1');
  });

  it('операция без amount -> amountKopecks undefined', async () => {
    vi.mocked(monetaFindByCtid).mockResolvedValue({
      id: 101,
      statusId: 'TAKENOUT',
      clientTransaction: 'ctid-2',
      raw: {},
    });
    const result = await provider.getStatus('ctid-2');
    expect(result.amountKopecks).toBeUndefined();
  });

  it('числовой providerPaymentId: amountKopecks из monetaGetOperation', async () => {
    const { monetaGetOperation } = await import('../src/moneta.js');
    vi.mocked(monetaGetOperation).mockResolvedValue({
      id: 200,
      statusId: 'SUCCEED',
      clientTransaction: 'ctid-3',
      amount: '150.00',
      raw: {},
    });
    const result = await provider.getStatus('200');
    expect(result.amountKopecks).toBe(15000);
  });
});

describe('п.4: confirm отклоняет payoutMode card/npd', () => {
  const provider = new MonetaProvider();

  beforeEach(() => {
    process.env.MONETA_ACCOUNT_ID = ACCOUNT_ID;
    process.env.MONETA_ACCOUNT_CODE = ACCOUNT_CODE;
  });

  it('payoutMode=card -> 402 «не настроено у провайдера»', async () => {
    await expect(
      provider.confirm('ctid-1', 'release-1', {
        sellerAccountRef: '12345',
        amountKopecks: 9800,
        platformFeeKopecks: 200,
        payoutMode: 'card',
      })
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('payoutMode=npd -> 402 «не настроено у провайдера»', async () => {
    await expect(
      provider.confirm('ctid-1', 'release-1', {
        sellerAccountRef: '12345',
        amountKopecks: 9800,
        platformFeeKopecks: 200,
        payoutMode: 'npd',
      })
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('payoutMode=account (или undefined) не блокируется на этом гварде', async () => {
    // Доводим до сетевого вызова: resolveOperation -> null -> CONFLICT.
    // Гвард payoutMode не срабатывает — получаем ошибку «операция не найдена».
    vi.mocked(monetaFindByCtid).mockResolvedValue(null);
    await expect(
      provider.confirm('ctid-1', 'release-1', {
        sellerAccountRef: '12345',
        amountKopecks: 9800,
        platformFeeKopecks: 200,
        payoutMode: 'account',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      provider.confirm('ctid-1', 'release-2', {
        sellerAccountRef: '12345',
        amountKopecks: 9800,
        platformFeeKopecks: 200,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
