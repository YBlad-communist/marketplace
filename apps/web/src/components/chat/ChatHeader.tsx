'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, MoreVerticalIcon } from './icons';

export function ChatHeader({
  otherId,
  otherName,
  otherAvatar,
}: {
  otherId: string | undefined;
  otherName: string;
  otherAvatar: string | null | undefined;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const back = () => {
    if (window.history.length > 1) router.back();
    else router.push('/chat');
  };

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
      <button
        type="button"
        onClick={back}
        aria-label="Назад к списку чатов"
        className="rounded-full p-2 text-textSecondary transition-colors hover:bg-surfaceMuted hover:text-textPrimary md:hidden"
      >
        <ArrowLeftIcon />
      </button>
      {otherId ? (
        <Link
          href={`/users/${otherId}`}
          aria-label={`Профиль пользователя ${otherName}`}
          className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accentSoft text-sm font-bold text-accentActive"
        >
          {otherAvatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={otherAvatar} alt="" className="h-full w-full object-cover" />
          ) : (
            (otherName[0] ?? '?').toUpperCase()
          )}
        </Link>
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accentSoft text-sm font-bold text-accentActive" aria-hidden>
          {(otherName[0] ?? '?').toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-textPrimary">{otherName}</div>
        <div className="truncate text-xs text-textMuted">был(а) недавно</div>
      </div>
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Меню чата"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="rounded-full p-2 text-textSecondary transition-colors hover:bg-surfaceMuted hover:text-textPrimary"
        >
          <MoreVerticalIcon />
        </button>
        {menuOpen && (
          <div role="menu" aria-label="Меню чата" className="absolute right-0 top-full z-40 mt-1 min-w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-modal">
            {otherId && (
              <Link
                role="menuitem"
                href={`/users/${otherId}`}
                className="block px-4 py-2 text-left text-sm text-textPrimary hover:bg-surfaceMuted"
                onClick={() => setMenuOpen(false)}
              >
                Профиль
              </Link>
            )}
            <button
              role="menuitem"
              type="button"
              className="block w-full px-4 py-2 text-left text-sm text-textPrimary hover:bg-surfaceMuted"
              onClick={() => {
                setMenuOpen(false);
                window.dispatchEvent(new CustomEvent('chat:clear-history'));
              }}
            >
              Очистить историю
            </button>
            <button
              role="menuitem"
              type="button"
              className="block w-full px-4 py-2 text-left text-sm text-danger hover:bg-surfaceMuted"
              onClick={() => {
                setMenuOpen(false);
                window.dispatchEvent(new CustomEvent('chat:delete'));
              }}
            >
              Удалить чат
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
