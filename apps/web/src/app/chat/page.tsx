'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { Header } from '@/components/Header';
import { ChatListPane } from '@/components/chat/ChatListPane';

function ChatListContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Легаси-ссылки вида /chat?conv=<id> (из карточки объявления и профиля) —
  // ведём на новый маршрут открытого чата.
  useEffect(() => {
    const conv = searchParams.get('conv');
    if (conv) router.replace(`/chat/${conv}`);
  }, [searchParams, router]);

  // Страница-список тоже без внешнего скролла.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div>
      <Header />
      <main className="container-x h-[calc(100dvh-var(--header-h)-var(--mobilenav-h))] overflow-hidden py-0 md:h-[calc(100dvh-var(--header-h))] md:py-6">
        <div className="flex h-full flex-col overflow-hidden md:mx-auto md:max-w-md">
          <h1 className="shrink-0 px-4 pb-2 pt-4 text-2xl font-semibold text-textPrimary">Сообщения</h1>
          <div className="min-h-0 flex-1">
            <ChatListPane />
          </div>
        </div>
      </main>
    </div>
  );
}

export default function ChatListPage() {
  return (
    <Suspense fallback={<div className="container-x py-6 text-textMuted">Загрузка…</div>}>
      <ChatListContent />
    </Suspense>
  );
}
