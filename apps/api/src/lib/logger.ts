import pino from 'pino';
import { env } from '../config.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.confirmPassword',
      'res.headers["set-cookie"]',
      '*.passwordHash',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[REDACTED]',
  },
  base: { service: 'marketplace-api' },
});

export function logSecurityEvent(
  event: string,
  detail: Record<string, unknown> = {}
): void {
  logger.warn({ security: true, event, ...detail }, `security: ${event}`);
}
