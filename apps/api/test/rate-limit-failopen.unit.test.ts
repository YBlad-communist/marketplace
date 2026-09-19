import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@marketplace/shared';

// Rate-limit middleware должен быть «fail-open» при проблемах Redis:
// Redis моргнул — вход/регистрация продолжают работать, а не отдают 500.

vi.mock('../src/config.js', () => ({
  env: {
    RATE_LIMIT_ENABLED: true,
    LOG_LEVEL: 'silent',
  },
}));

const getRedisMock = vi.hoisted(() => ({
  redisDown: vi.fn<() => unknown>(() => {
    throw new Error('connect ECONNREFUSED');
  }),
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => getRedisMock.redisDown(),
}));

import { checkRateLimit, ipRateLimit } from '../src/middleware/rateLimit.js';

function reqStub() {
  return { ip: '8.8.8.8', socket: { remoteAddress: '8.8.8.8' } } as never;
}

describe('rate limit: fail-open при недоступном Redis', () => {
  it('getRedis кидает — middleware пропускает запрос (next() без ошибки)', async () => {
    const next = vi.fn();
    const middleware = ipRateLimit('auth:login', 60_000, 10);
    await middleware(reqStub(), { setHeader: vi.fn() } as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it('Redis отвечает и лимит превышен — 429 (AppError RATE_LIMITED)', async () => {
    // Имитируем живой Redis, у которого счётчик уже превышен (count=99 > max=5).
    getRedisMock.redisDown.mockImplementationOnce(() => ({
      incr: async () => 99,
      expire: async () => 'OK' as const,
    }));
    const next = vi.fn();
    const middleware = ipRateLimit('test:hourly', 3_600_000, 5);
    await middleware(reqStub(), { setHeader: vi.fn() } as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(429);
    expect((err as AppError).code).toBe('RATE_LIMITED');
  });

  it('checkRateLimit возвращает остаток (remaining=0 при превышении)', async () => {
    getRedisMock.redisDown.mockImplementationOnce(() => ({
      incr: async () => 99,
      expire: async () => 'OK' as const,
    }));
    const { allowed, remaining } = await checkRateLimit('rl:u:x:1', 60_000, 5);
    expect(allowed).toBe(false);
    expect(remaining).toBe(0);
  });
});