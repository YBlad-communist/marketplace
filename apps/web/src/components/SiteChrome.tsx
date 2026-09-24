'use client';

import { usePathname } from 'next/navigation';
import { Footer } from '@/components/Footer';

/**
 * Хром страниц чата в стиле Telegram: чат занимает ровно один экран,
 * поэтому Footer скрыт, а отступ под MobileNav добавляется только там,
 * где навигация видима. Разметка остальных страниц не меняется.
 */
export function SiteChrome() {
  const pathname = usePathname();
  const isChat = pathname === '/chat' || pathname.startsWith('/chat/');
  const isOpenChat = pathname.startsWith('/chat/');

  return (
    <>
      {!isChat && <Footer />}
      {/* DECISION: отступ вместо pb-обёртки layout, чтобы высота чата считалась точно */}
      {!isOpenChat && <div className="h-20 md:hidden" aria-hidden />}
    </>
  );
}
