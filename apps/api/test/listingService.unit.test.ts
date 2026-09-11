import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, sortOptions } from '../src/services/listingService.js';

describe('cursor pagination helpers', () => {
  it('round-trips a date cursor', () => {
    const date = new Date('2024-05-01T10:00:00.000Z');
    const cursor = encodeCursor(date, 'clr123');
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe('clr123');
    expect(decoded.primary).toBeInstanceOf(Date);
    expect((decoded.primary as Date).toISOString()).toBe(date.toISOString());
  });

  it('round-trips a numeric cursor', () => {
    const cursor = encodeCursor(150.5, 'abc');
    const decoded = decodeCursor(cursor);
    expect(decoded.primary).toBe(150.5);
    expect(decoded.id).toBe('abc');
  });

  it('throws on malformed cursor', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow();
  });
});

describe('sort options', () => {
  it('maps all supported sorts', () => {
    expect(sortOptions('price_asc')).toEqual({ field: 'price', dir: 'asc' });
    expect(sortOptions('price_desc')).toEqual({ field: 'price', dir: 'desc' });
    expect(sortOptions('date_asc')).toEqual({ field: 'createdAt', dir: 'asc' });
    expect(sortOptions('date_desc')).toEqual({ field: 'createdAt', dir: 'desc' });
    expect(sortOptions('relevance')).toEqual({ field: 'createdAt', dir: 'desc' });
  });
});
