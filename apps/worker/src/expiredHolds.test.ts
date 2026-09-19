import { describe, expect, it } from 'vitest';
import { decideHoldOutcome } from './expiredHolds.js';

describe('decideHoldOutcome', () => {
  it('живой холд не трогаем', () => {
    expect(decideHoldOutcome('waiting_for_capture')).toBe('held');
  });

  it('мёртвый холд закрываем возвратом', () => {
    expect(decideHoldOutcome('canceled')).toBe('expired');
    expect(decideHoldOutcome('pending')).toBe('expired');
  });

  it('непонятные статусы не трогаем, только лог', () => {
    expect(decideHoldOutcome('succeeded')).toBe('unknown');
    expect(decideHoldOutcome('processing')).toBe('unknown');
    expect(decideHoldOutcome('')).toBe('unknown');
  });
});
