import { logger } from '../lib/logger.js';

export interface ScheduleOptions {
  attempts?: number;
  baseDelayMs?: number;
}

/**
 * Регистрация защитных repeatable-джоб при старте API (чистка токенов,
 * зависших эскроу-холдов, recovery застрявших RELEASING-заказов).
 *
 * Раньше ошибки BullMQ-регистрации глотались `catch(() => undefined)`: если
 * Redis на секунду недоступен при деплое, процесс живёт дальше, но защитные
 * джобы просто не запланированы — и это не видно ни в логах, ни в метриках.
 * Здесь: экспоненциальные ретраи (3 попытки с паузой BASE·2^(n-1)) и
 * обязательный лог ошибки. Возвращаем успех/провал для возможного health-алерта.
 */
export async function scheduleCriticalJob(
  name: string,
  enqueue: () => Promise<void>,
  options: ScheduleOptions = {}
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await enqueue();
      return true;
    } catch (err) {
      logger.error(
        { err, job: name, attempt, maxAttempts: attempts },
        'failed to schedule critical maintenance job'
      );
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  return false;
}