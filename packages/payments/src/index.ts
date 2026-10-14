export { paymentEnv, type PaymentEnv } from './env.js';
export { getPaymentProvider, resetPaymentProviderForTests } from './factory.js';

// Клиенты
export * as monetaClient from './moneta.js';
export * as yookassaClient from './yookassa.js';

// Провайдеры
export { YooKassaProvider, normalizeYooStatus } from './yookassaProvider.js';
export { MonetaProvider } from './monetaProvider.js';
export { MockPaymentProvider, mockPaymentProvider, createMockPaymentProvider } from './mockProvider.js';

// Удобные реэкспорты клиентов (для paymentService API)
export {
  buildAssistantPayUrl,
  monetaAmount,
  monetaCancelTransaction,
  monetaConfigured,
  monetaFindByCtid,
  monetaFormSignature,
  monetaGetOperation,
  monetaMerchantCall,
  monetaNotificationSignature,
  monetaRefund,
  monetaTransferToSeller,
  normalizeMonetaStatus,
} from './moneta.js';

export type { MonetaOperation } from './moneta.js';

export {
  captureKeyFor,
  cancelKeyFor,
  cancelYookassaPayment,
  captureYookassaPayment,
  createYookassaPayment,
  expiredCancelKeyFor,
  getYookassaPayment,
  isTrustedYookassaIp,
  numberFromAmount,
  refundCancelKeyFor,
  refundKeyFor,
  refundYookassaPayment,
  toAmount,
  yookassaConfigured,
  YOOKASSA_NOTIFICATION_IP_RANGES,
  YOOKASSA_API_URL,
} from './yookassa.js';

export type {
  YooAmount,
  YooPayment,
  YooPaymentStatus,
  YooPaymentTransfer,
  YooRefund,
} from './yookassa.js';
