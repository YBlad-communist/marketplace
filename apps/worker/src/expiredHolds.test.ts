import { describe, expect, it } from 'vitest';
import { decideHoldOutcome } from './expiredHolds.js';

describe('decideHoldOutcome', () => {
  it('живой холд не трогаем', () => {
    expect(decideHoldOutcome('authorized')).toBe('held');
  });

  it('мёртвый холд закрываем возвратом', () => {
    expect(decideHoldOutcome('canceled')).toBe('expired');
    expect(decideHoldOutcome('pending')).toBe('expired');
  });

  it('непонятные статусы не трогаем, только лог', () => {
    expect(decideHoldOutcome('captured')).toBe('unknown');
    expect(decideHoldOutcome('refunded')).toBe('unknown');
    expect(decideHoldOutcome('unknown')).toBe('unknown');
  });
});
