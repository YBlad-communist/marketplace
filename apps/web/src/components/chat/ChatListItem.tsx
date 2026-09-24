'use client';

import Link from 'next/link';
import { ConversationDto } from '@/lib/types';
import { cn, formatChatTime } from '@/lib/format';

function previewText(c: ConversationDto): string {
  const last = c.lastMessage;
  if (!last) return 'Нет сообщений';
  if (last.deletedAt) return 'Сообщение удалено';
  if (last.text) return last.text;
  return '📷 Фото';
}

export function ChatListItem({
  conversation,
  userId,
  active,
}: {
  conversation: ConversationDto;
  userId: string | undefined;
  active: boolean;
}) {
  const c = conversation;
  const other = c.participants.find((p) => p.id !== userId);
  const name = other?.name ?? 'Чат';

  return (
    <Link
      href={`/chat/${c.id}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-[72px] items-center gap-3 px-3 transition-colors',
        active ? 'bg-accentSoft' : 'hover:bg-surfaceMuted'
      )}
    >
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accentSoft text-base font-bold text-accentActive"
        aria-hidden
      >
        {other?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={other.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          (name[0] ?? '?').toUpperCase()
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium text-textPrimary">{name}</span>
          {c.lastMessage && (
            <span className="shrink-0 text-xs text-textMuted">{formatChatTime(c.lastMessage.createdAt)}</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-textSecondary">{previewText(c)}</span>
          {c.unreadCount > 0 && (
            <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-medium text-white">
              {c.unreadCount > 99 ? '99+' : c.unreadCount}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
