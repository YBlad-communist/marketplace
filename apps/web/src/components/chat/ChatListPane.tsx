'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';import { useQuery } from '@tanstack/react-query';
import { ChatListItem } from './ChatListItem';
import { SearchIcon } from './icons';
import { EmptyState } from '@/components/ui/primitives';
import { get } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { ConversationDto } from '@/lib/types';

export function ChatListPane({ activeId }: { activeId?: string }) {
  const userId = useAuthStore((s) => s.user?.id);
  const [filter, setFilter] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(filter.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [filter]);

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => get<{ data: { items: ConversationDto[] } }>('/api/conversations'),
  });
  // DECISION: мемоизируем массив, чтобы фильтр useMemo ниже не пересчитывался каждый рендер.
  const conversations = useMemo(
    () => conversationsQuery.data?.data.items ?? [],
    [conversationsQuery.data]
  );

  const visible = useMemo(() => {
    if (!debounced) return conversations;
    return conversations.filter((c) => {
      const name = (c.participants.find((p) => p.id !== userId)?.name ?? '').toLowerCase();
      const last = c.lastMessage;
      const text = last && !last.deletedAt ? `${last.text ?? ''}`.toLowerCase() : '';
      return name.includes(debounced) || text.includes(debounced);
    });
  }, [conversations, debounced, userId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textMuted" aria-hidden>
            <SearchIcon className="h-4 w-4" />
          </span>
          <label htmlFor="chat-search" className="sr-only">
            Поиск по чатам
          </label>
          <input
            id="chat-search"
            className="input !rounded-full !bg-surfaceMuted !pl-9"
            placeholder="Поиск"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <div className="nice-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" role="list" aria-label="Список чатов">
        {conversationsQuery.isLoading && (
          <div role="status" aria-label="Загрузка чатов">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex h-[72px] items-center gap-3 px-3" aria-hidden>
                <div className="skeleton h-12 w-12 !rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-2/3" />
                  <div className="skeleton h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!conversationsQuery.isLoading &&
          visible.map((c, i) => (
            <div key={c.id} role="listitem" className={i < visible.length - 1 ? 'border-b border-border' : undefined}>
              <ChatListItem conversation={c} userId={userId} active={c.id === activeId} />
            </div>
          ))}
        {!conversationsQuery.isLoading && conversations.length === 0 && (
          <EmptyState
            title="Чатов пока нет"
            hint="Откройте объявление и нажмите «Написать продавцу»"
            action={
              <Link href="/" className="btn-secondary text-sm">
                Перейти к объявлениям
              </Link>
            }
          />
        )}
        {!conversationsQuery.isLoading && conversations.length > 0 && visible.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-textSecondary">Ничего не найдено</div>
        )}
      </div>
    </div>
  );
}
