import { describe, expect, it } from 'vitest';
import { sanitizeEmailPlainText } from './notificationJob.js';

describe('п.39: очистка текста писем saved-search от ссылок', () => {
  it('дефангит http(s)-ссылки в названии объявления', () => {
    const out = sanitizeEmailPlainText('Продам ноутбук https://evil.example/phish дёшево');
    expect(out).not.toContain('https://evil.example');
    expect(out).toContain('https[://]evil.example');
    expect(out).toContain('Продам ноутбук');
    expect(out).toContain('дёшево');
  });

  it('дефангит www-домены', () => {
    const out = sanitizeEmailPlainText('смотри www.evil.example прямо сейчас');
    expect(out).not.toContain('www.evil.example');
    expect(out).toContain('www[.]evil.example');
  });

  it('схлопывает переводы строки и управляющие символы (одна строка текста)', () => {
    const out = sanitizeEmailPlainText('Первая строка\nвторая\r\nтретья\tи хвост');
    expect(out).not.toMatch(/[\n\r\t]/);
    expect(out).toBe('Первая строка вторая третья и хвост');
  });

  it('обычный текст не искажает', () => {
    const text = 'Велосипед горный — 5000 ₽, Казань';
    expect(sanitizeEmailPlainText(text)).toBe(text);
  });
});
