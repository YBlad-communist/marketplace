'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { slideDirection } from '@/lib/nav-order';

/**
 * Живёт в layout (не размонтируется), поэтому помнит предыдущий маршрут
 * и выбирает направление слайда. key={pathname} перезапускает анимацию.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const prevRef = useRef<string | null>(null);

  const dir = slideDirection(prevRef.current, pathname);
  const cls = dir === 1 ? 'page-slide-right' : dir === -1 ? 'page-slide-left' : 'page-enter';

  useEffect(() => {
    prevRef.current = pathname;
  }, [pathname]);

  return (
    <div key={pathname} className={cls}>
      {children}
    </div>
  );
}
