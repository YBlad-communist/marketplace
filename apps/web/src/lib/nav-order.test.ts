import { describe, expect, it } from 'vitest';
import { navIndex, slideDirection } from './nav-order';

describe('navIndex', () => {
  it('раскладывает пункты шапки слева направо', () => {
    expect(navIndex('/')).toBe(0);
    expect(navIndex('/listings/new')).toBe(1);
    expect(navIndex('/chat')).toBe(2);
    expect(navIndex('/orders')).toBe(3);
    expect(navIndex('/favorites')).toBe(4);
    expect(navIndex('/cabinet')).toBe(5);
    expect(navIndex('/admin')).toBe(6);
    expect(navIndex('/login')).toBe(7);
    expect(navIndex('/register')).toBe(8);
  });

  it('относит вложенные страницы к разделам панели', () => {
    expect(navIndex('/listings/abc')).toBe(0);
    expect(navIndex('/listings/abc/edit')).toBe(0);
    expect(navIndex('/users/abc')).toBe(0);
    expect(navIndex('/seller/connect')).toBe(5);
  });

  it('возвращает null для неизвестных маршрутов', () => {
    expect(navIndex('/not-found-xyz')).toBeNull();
  });
});

describe('slideDirection', () => {
  it('вправо по панели — 1, влево — -1', () => {
    expect(slideDirection('/', '/chat')).toBe(1);
    expect(slideDirection('/orders', '/')).toBe(-1);
  });

  it('первая загрузка, один раздел и неизвестные маршруты — 0 (fade)', () => {
    expect(slideDirection(null, '/')).toBe(0);
    expect(slideDirection('/listings/a', '/listings/b')).toBe(0);
    expect(slideDirection('/', '/not-found-xyz')).toBe(0);
    expect(slideDirection('/not-found-xyz', '/')).toBe(0);
  });
});
