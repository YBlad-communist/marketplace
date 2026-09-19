/**
 * Порядок пунктов шапки слева направо (десктоп):
 * Каталог (/) → Разместить (/listings/new) → Чаты → Заказы → Избранное →
 * Кабинет → Модерация → Войти → Регистрация.
 * Используется для направленных слайдов между страницами.
 */

export function navIndex(pathname: string): number | null {
  if (pathname === '/') return 0;
  if (pathname.startsWith('/listings/new')) return 1;
  if (pathname.startsWith('/listings')) return 0;
  if (pathname.startsWith('/chat')) return 2;
  if (pathname.startsWith('/orders')) return 3;
  if (pathname.startsWith('/favorites')) return 4;
  if (pathname.startsWith('/cabinet')) return 5;
  if (pathname.startsWith('/seller/connect')) return 5;
  if (pathname.startsWith('/admin')) return 6;
  if (pathname.startsWith('/login')) return 7;
  if (pathname.startsWith('/register')) return 8;
  if (pathname.startsWith('/users')) return 0;
  return null;
}

/** 1 — переход вправо по панели, -1 — влево, 0 — fade (неизвестный маршрут). */
export function slideDirection(from: string | null, to: string): 1 | -1 | 0 {
  if (from === null) return 0;
  const a = navIndex(from);
  const b = navIndex(to);
  if (a === null || b === null || a === b) return 0;
  return b > a ? 1 : -1;
}
