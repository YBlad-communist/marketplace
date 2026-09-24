'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/auth-store';
import { get, post, setAccessToken } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { CategoryDto } from '@/lib/types';
import { cn } from '@/lib/format';

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function HeartIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? 'h-6 w-6'} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? 'h-6 w-6'} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8m-8 4h5m7-2a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z" />
    </svg>
  );
}

function UserIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? 'h-6 w-6'} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path strokeLinecap="round" d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </svg>
  );
}

function CatalogIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function IconLink({ href, label, active, children }: { href: string; label: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'hidden flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[11px] leading-tight transition-colors sm:flex',
        active ? 'font-semibold text-accent' : 'text-textSecondary hover:text-textPrimary'
      )}
    >
      {children}
      <span>{label}</span>
    </Link>
  );
}

export function Header() {
  const { user, setUser } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(false);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => get<{ data: { categories: CategoryDto[] } }>('/api/categories'),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    // Не дёргаем /me для гостей на каждой странице: если пользователя нет в сторе —
    // пробуем тихую сессию один раз (refresh cookie), иначе остаёмся гостем.
    let cancelled = false;
    get<{ data: { user: Parameters<typeof setUser>[0] } }>('/api/users/me')
      .then((r) => {
        if (!cancelled) setUser(r.data.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  useEffect(() => {
    if (!catalogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCatalogOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [catalogOpen]);

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setAccessToken(null);
    disconnectSocket();
    setUser(null);
    router.push('/');
    router.refresh();
  };

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    router.push(`/${params.toString() ? `?${params.toString()}` : ''}`);
  };

  const categories = categoriesQuery.data?.data.categories ?? [];

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface">
      {/* DECISION: фиксированная высота = --header-h (60px): чат-страницы считают
          высоту от неё, любое расхождение даёт внешний скролл и «съезжание». */}
      <div className="container-x flex h-[60px] items-center gap-2 md:gap-4">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="РынокRU — на главную">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-xl font-bold text-white" aria-hidden>
            Р
          </span>
          <span className="hidden text-xl font-bold tracking-tight text-textPrimary lg:inline">
            Рынок<span className="text-accent">RU</span>
          </span>
        </Link>

        <div className="relative hidden shrink-0 md:block">
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={catalogOpen}
            aria-haspopup="menu"
            onClick={() => setCatalogOpen((v) => !v)}
          >
            <CatalogIcon />
            Каталог
          </button>
          {catalogOpen && (
            <div role="menu" aria-label="Категории" className="absolute left-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-border bg-surface py-2 shadow-modal">
              <Link
                href="/"
                role="menuitem"
                className="block px-4 py-2 text-sm font-medium text-textPrimary hover:bg-surfaceMuted"
                onClick={() => setCatalogOpen(false)}
              >
                Все категории
              </Link>
              {categories.map((c) => (
                <div key={c.id}>
                  <Link
                    href={`/?cat=${c.id}`}
                    role="menuitem"
                    className="block px-4 py-2 text-sm font-medium text-textPrimary hover:bg-surfaceMuted"
                    onClick={() => setCatalogOpen(false)}
                  >
                    {c.name}
                  </Link>
                  {(c.children ?? []).map((ch) => (
                    <Link
                      key={ch.id}
                      href={`/?cat=${ch.id}`}
                      role="menuitem"
                      className="block px-4 py-1.5 pl-8 text-sm text-textSecondary hover:bg-surfaceMuted hover:text-textPrimary"
                      onClick={() => setCatalogOpen(false)}
                    >
                      {ch.name}
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <form onSubmit={submitSearch} role="search" className="flex min-w-0 flex-1 items-center">
          <label htmlFor="header-search" className="sr-only">
            Поиск по объявлениям
          </label>
          <input
            id="header-search"
            className="input !rounded-r-none border-r-0"
            placeholder="Поиск: смартфон, квартира…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" aria-label="Найти" className="btn-primary shrink-0 !rounded-l-none px-4">
            <SearchIcon />
          </button>
        </form>

        <Link href="/listings/new" className="btn-primary hidden shrink-0 md:inline-flex">
          + Разместить
        </Link>

        <nav className="flex shrink-0 items-center gap-1" aria-label="Пользовательская навигация">
          {user ? (
            <>
              <IconLink href="/favorites" label="Избранное" active={isActive('/favorites')}>
                <HeartIcon />
              </IconLink>
              <IconLink href="/chat" label="Чаты" active={isActive('/chat')}>
                <ChatIcon />
              </IconLink>
              <IconLink href="/cabinet" label="Профиль" active={isActive('/cabinet') || isActive('/orders')}>
                <UserIcon />
              </IconLink>
              {(user.role === 'ADMIN' || user.role === 'MODERATOR') && (
                <Link href="/admin" className="hidden rounded-lg px-2 py-1 text-xs text-textSecondary hover:text-textPrimary lg:block">
                  Модерация
                </Link>
              )}
              <button
                type="button"
                onClick={logout}
                aria-label="Выйти из аккаунта"
                className="hidden rounded-lg px-2 py-1 text-xs text-textMuted transition-colors hover:text-danger lg:block"
              >
                Выйти
              </button>
            </>
          ) : (
            <Link href="/login" className="btn-secondary hidden shrink-0 !px-3 !py-1.5 sm:inline-flex">
              Войти
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
