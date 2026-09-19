import { describe, expect, it } from 'vitest';
import {
  OTP_DAY_MAX,
  OTP_DAY_MS,
  OTP_HOUR_MAX,
  OTP_HOUR_MS,
  OTP_MIN_INTERVAL_MS,
  otpBlockedRetryMs,
  otpBuckets,
} from '../src/services/verificationService.js';

const T0 = Date.now();

describe('otpBuckets', () => {
  it('содержит минутное и часовое ведро по цели', () => {
    const buckets = otpBuckets('+79990001122');
    expect(buckets).toEqual([
      { key: 'otp:send:+79990001122', windowMs: OTP_MIN_INTERVAL_MS, max: 1 },
      { key: 'otp:send:+79990001122', windowMs: OTP_HOUR_MS, max: OTP_HOUR_MAX },
    ]);
  });

  it('добавляет суточное ведро по userId только при заданном userId', () => {
    const withUser = otpBuckets('+79990001122', 'user-1');
    const withoutUser = otpBuckets('+79990001122');
    expect(withUser).toHaveLength(3);
    expect(withoutUser).toHaveLength(2);
    expect(withUser[2]).toEqual({
      key: 'otp:send:user:user-1',
      windowMs: OTP_DAY_MS,
      max: OTP_DAY_MAX,
    });
  });

  it('разные цели не делят вёдра', () => {
    const a = otpBuckets('+79990001122')[0].key.split(':')[2].includes('+79990001122');
    const b = otpBuckets('+79990001133')[0].key.split(':')[2].includes('+79990001133');
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

describe('otpBlockedRetryMs', () => {
  const minuteBucket = { key: 'otp:send:+79990001122', windowMs: OTP_MIN_INTERVAL_MS, max: 1 };

  it('не блокирует при count <= max', () => {
    expect(otpBlockedRetryMs(minuteBucket, T0, 1)).toBe(0);
    expect(otpBlockedRetryMs({ ...minuteBucket, max: 5 }, T0, 5)).toBe(0);
  });

  it('блокирует при count > max, retry >= 1 сек до конца окна', () => {
    const ok = otpBlockedRetryMs(minuteBucket, T0, 2);
    expect(ok).toBeGreaterThanOrEqual(1000);
    expect(ok).toBeLessThanOrEqual(OTP_MIN_INTERVAL_MS);
  });

  it('retry вычисляется до конца текущего окна', () => {
    const windowMs = OTP_HOUR_MS;
    const windowStart = Math.floor(T0 / windowMs) * windowMs;
    const now = windowStart + 30 * 1000; // 30 сек от начала часового окна
    const retry = otpBlockedRetryMs({ key: 'k', windowMs, max: 5 }, now, 6);
    expect(retry).toBeCloseTo(windowMs - 30_000, -3);
  });

  it('не пересекается между пользователями/целями (изоляция ключей)', () => {
    const a = otpBuckets('+79990001122', 'u1');
    const b = otpBuckets('+79990001122', 'u2');
    const keys = (bs: { key: string }[]) => bs.map((x) => x.key);
    expect(keys(a).filter((k) => k.includes('u1'))).toHaveLength(1);
    expect(keys(b).filter((k) => k.includes('u2'))).toHaveLength(1);
  });
});