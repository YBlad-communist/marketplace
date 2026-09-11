'use client';

import { usePathname } from 'next/navigation';

/**
 * Тонкий прогресс-бар сверху при смене маршрута.
 * key={pathname} перезапускает CSS-анимацию на каждом переходе.
 */
export function RouteProgress() {
  const pathname = usePathname();
  return <div key={pathname} className="route-progress" aria-hidden />;
}
