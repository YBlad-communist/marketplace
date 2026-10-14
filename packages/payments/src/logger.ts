import pino from 'pino';

/** Минимальный logger пакета (не тянет api-config). */
export const paymentsLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'marketplace-payments' },
});
