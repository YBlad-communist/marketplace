import { describe, expect, it, vi } from 'vitest';

// Стартовые repeatable-джобы обязаны логировать сбои, а не глотать молча:
// если Redis при деплое на секунду недоступен, чистильщик холдов / recovery
// выплат не запланируется, и это должно быть видно в логах.
vi.mock('../src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { logger } from '../src/lib/logger.js';
import { scheduleCriticalJob } from '../src/services/jobScheduler.js';

describe('scheduleCriticalJob', () => {
  it('при недоступном Redis: retry 3 раза, лог ошибок, не кидает исключение', async () => {
    (logger.error as ReturnType<typeof vi.fn>).mockClear();
    const enqueue = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });

    const ok = await scheduleCriticalJob('job-x', enqueue, { attempts: 3, baseDelayMs: 1 });

    expect(ok).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'job-x', attempt: 1, maxAttempts: 3 }),
      expect.stringContaining('failed to schedule critical maintenance job')
    );
  });

  it('успех на второй попытке: не ретраим лишнего', async () => {
    (logger.error as ReturnType<typeof vi.fn>).mockClear();
    let calls = 0;
    const enqueue = async () => {
      calls += 1;
      if (calls < 2) throw new Error('redis blip');
    };

    const ok = await scheduleCriticalJob('job-y', enqueue, { attempts: 3, baseDelayMs: 1 });

    expect(ok).toBe(true);
    expect(calls).toBe(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('успех с первой попытки: никаких логов ошибок', async () => {
    (logger.error as ReturnType<typeof vi.fn>).mockClear();
    const enqueue = vi.fn(async () => undefined);

    const ok = await scheduleCriticalJob('job-z', enqueue, { attempts: 3, baseDelayMs: 1 });

    expect(ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});