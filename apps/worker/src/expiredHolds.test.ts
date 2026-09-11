import { describe, expect, it } from 'vitest';
import { decideHoldOutcome } from './expiredHolds.js';

describe('decideHoldOutcome', () => {
  it('живой холд не трогаем', () => {
    expect(decideHoldOutcome('requires_capture')).toBe('held');
  });

  it('мёртвый холд закрываем возвратом', () => {
    expect(decideHoldOutcome('canceled')).toBe('expired');
    expect(decideHoldOutcome('requires_payment_method')).toBe('expired');
  });

  it('непонятные статусы не трогаем, только лог', () => {
    expect(decideHoldOutcome('succeeded')).toBe('unknown');
    expect(decideHoldOutcome('requires_action')).toBe('unknown');
    expect(decideHoldOutcome('processing')).toBe('unknown');
    expect(decideHoldOutcome('')).toBe('unknown');
  });
});
