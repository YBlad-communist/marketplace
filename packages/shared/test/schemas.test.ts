import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  registerSchema,
  listingCreateSchema,
  listingQuerySchema,
  sendMessageSchema,
  createOrderSchema,
  usersMeUpdateSchema,
  reportCreateSchema,
} from '../src/index.js';

describe('auth schemas', () => {
  it('accepts a valid registration', () => {
    const r = registerSchema.safeParse({
      name: 'Иван',
      phone: '+79991234567',
      password: 'Strong123',
      confirmPassword: 'Strong123',
    });
    expect(r.success).toBe(true);
  });

  it('rejects weak password', () => {
    const r = registerSchema.safeParse({
      name: 'Иван',
      phone: '+79991234567',
      password: 'weak',
      confirmPassword: 'weak',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'password')).toBe(true);
  });

  it('rejects mismatched confirm password', () => {
    const r = registerSchema.safeParse({
      name: 'Иван',
      phone: '+79991234567',
      password: 'Strong123',
      confirmPassword: 'Strong456',
    });
    expect(r.success).toBe(false);
  });

  it('normalizes phone to +7 format', () => {
    const r = loginSchema.safeParse({ phone: '89991234567', password: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBe('+79991234567');
  });
});

describe('listing schemas', () => {
  it('accepts a valid listing create', () => {
    const r = listingCreateSchema.safeParse({
      title: 'iPhone 15 Pro',
      description: 'Отличный смартфон, 128 ГБ, полный комплект',
      price: 700,
      categoryId: 'clr00000000000000000000000',
      city: 'Москва',
    });
    expect(r.success).toBe(true);
  });

  it('rejects negative price', () => {
    const r = listingCreateSchema.safeParse({
      title: 'iPhone 15 Pro',
      description: 'Отличный смартфон',
      price: -1,
      categoryId: 'clr00000000000000000000000',
      city: 'Москва',
    });
    expect(r.success).toBe(false);
  });

  it('parses numeric query fields via coerce', () => {
    const r = listingQuerySchema.safeParse({ minPrice: '100', maxPrice: '500', limit: '10' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.minPrice).toBe(100);
      expect(r.data.limit).toBe(10);
    }
  });

  it('limits page size to 50', () => {
    const r = listingQuerySchema.safeParse({ limit: 500 });
    expect(r.success).toBe(false);
  });
});

describe('chat / misc schemas', () => {
  it('rejects overlong message', () => {
    const r = sendMessageSchema.safeParse({ conversationId: 'clr12345678901234567890123', text: 'x'.repeat(2001) });
    expect(r.success).toBe(false);
  });

  it('accepts valid order with idempotency key', () => {
    const r = createOrderSchema.safeParse({
      listingId: 'clr12345678901234567890123',
      idempotencyKey: 'ord-abc-123',
    });
    expect(r.success).toBe(true);
  });

  it('accepts empty users/me update patch is invalid', () => {
    const r = usersMeUpdateSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts report schema', () => {
    const r = reportCreateSchema.safeParse({
      targetType: 'LISTING',
      targetId: 'clr12345678901234567890123',
      reason: 'SPAM',
    });
    expect(r.success).toBe(true);
  });
});
