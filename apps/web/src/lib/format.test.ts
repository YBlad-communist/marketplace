import { describe, expect, it } from 'vitest';
import { formatPrice } from './format';

describe('п.3: formatPrice', () => {
  it('валюта по умолчанию — RUB', () => {
    const out = formatPrice(100);
    // Intl.NumberFormat ru-RU + RUB -> «100 ₽» (₽ или RUB в зависимости от ICU)
    expect(out).toMatch(/100/);
    expect(out).toMatch(/[₽Rруб]/i);
    expect(out).not.toMatch(/€|EUR/);
  });

  it('явная валюта работает', () => {
    const out = formatPrice(100, 'USD');
    expect(out).toMatch(/100/);
    expect(out).toMatch(/\$|USD/i);
  });

  it('строковое значение конвертируется', () => {
    const out = formatPrice('250');
    expect(out).toMatch(/250/);
  });
});
