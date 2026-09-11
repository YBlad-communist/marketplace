'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { get, post, setAccessToken } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { cn } from '@/lib/format';

function NavLink({ href, children, active }: { href: string; children: React.ReactNode; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative rounded-lg px-2 py-1 transition-colors hover:text-brand-700',
        active ? 'font-semibold text-brand-700' : 'text-gray-700'
      )}
    >
      {children}
      {active && <span className="absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full bg-brand-600" aria-hidden />}
    </Link>
  );
}

export function Header() {
  const { user, setUser } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

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

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setAccessToken(null);
    disconnectSocket();
    setUser(null);
    router.push('/');
    router.refresh();
  };

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2" aria-label="Marketplace — на главную">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white" aria-hidden>
            M
          </span>
          <span className="text-xl font-bold tracking-tight text-gray-900">
            Market<span className="text-brand-600">place</span>
          </span>
        </Link>

        <nav className="flex flex-1 items-center gap-1 text-sm" aria-label="Основная навигация">
          <NavLink href="/" active={isActive('/')}>
            Каталог
          </NavLink>
          <Link href="/listings/new" className="btn-primary ml-1 !px-3 !py-1.5">
            + Разместить
          </Link>
        </nav>

        <div className="flex items-center gap-1 text-sm">
          {user ? (
            <>
              <NavLink href="/chat" active={isActive('/chat')}>
                Чаты
              </NavLink>
              <NavLink href="/orders" active={isActive('/orders')}>
                Заказы
              </NavLink>
              <NavLink href="/favorites" active={isActive('/favorites')}>
                Избранное
              </NavLink>
              <NavLink href="/cabinet" active={isActive('/cabinet')}>
                {user.name}
              </NavLink>
              {(user.role === 'ADMIN' || user.role === 'MODERATOR') && (
                <NavLink href="/admin" active={isActive('/admin')}>
                  Модерация
                </NavLink>
              )}
              <button onClick={logout} className="rounded-lg px-2 py-1 text-gray-500 transition-colors hover:text-gray-900">
                Выйти
              </button>
            </>
          ) : (
            <>
              <NavLink href="/login" active={isActive('/login')}>
                Войти
              </NavLink>
              <Link href="/register" className="btn-primary ml-1 !px-3 !py-1.5">
                Регистрация
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
