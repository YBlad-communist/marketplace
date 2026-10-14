import type { PaymentProvider } from '@marketplace/shared';
import { paymentEnv } from './env.js';
import { YooKassaProvider } from './yookassaProvider.js';
import { MonetaProvider } from './monetaProvider.js';
import { createMockPaymentProvider } from './mockProvider.js';

/**
 * Фабрика платежного провайдера: создаётся один раз на процесс
 * (env PAYMENT_PROVIDER=yookassa|moneta|mock), остальной код работает
 * только через интерфейс PaymentProvider.
 */
let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;

  switch (paymentEnv.PAYMENT_PROVIDER) {
    case 'mock':
      cached = createMockPaymentProvider();
      break;
    case 'moneta':
      cached = new MonetaProvider();
      break;
    case 'yookassa':
    default:
      cached = new YooKassaProvider();
      break;
  }
  return cached;
}

/** Сброс кэша (только для тестов, сменивших env). */
export function resetPaymentProviderForTests(): void {
  cached = null;
}
