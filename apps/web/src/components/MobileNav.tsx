'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/format';

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9z" />
    </svg>
  );
}

function SearchIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-2xl leading-none text-white shadow-card-hover" aria-hidden>
      +
    </span>
  );
}

function HeartIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
    </svg>
  );
}

function UserIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path strokeLinecap="round" d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </svg>
  );
}

// DECISION: «Поиск» ведёт на якорь #search главной (фокус на поле поиска
// без изменения логики фильтров), поэтому active для него всегда false.
const items = [
  { href: '/', label: 'Главная', Icon: HomeIcon, exact: true, anchor: false },
  { href: '/#search', label: 'Поиск', Icon: SearchIcon, exact: false, anchor: true },
  { href: '/listings/new', label: 'Разместить', Icon: null, exact: false, anchor: false },
  { href: '/favorites', label: 'Избранное', Icon: HeartIcon, exact: false, anchor: false },
  { href: '/cabinet', label: 'Профиль', Icon: UserIcon, exact: false, anchor: false },
];

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Мобильная навигация" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="grid grid-cols-5">
        {items.map(({ href, label, Icon, exact, anchor }) => {
          const active = !anchor && (exact ? pathname === href : pathname.startsWith(href));
          return (
            <Link
              key={label}
              href={href}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-0.5 py-2 text-[11px] leading-tight',
                active ? 'font-semibold text-accent' : 'text-textSecondary'
              )}
            >
              {Icon ? <Icon active={active} /> : <PlusIcon />}
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
