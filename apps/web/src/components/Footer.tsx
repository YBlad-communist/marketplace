import Link from 'next/link';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="container-x flex flex-col gap-4 py-6 text-sm text-textSecondary sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent text-xs font-bold text-white" aria-hidden>
            Р
          </span>
          <span>
            <strong className="font-semibold text-textPrimary">РынокRU</strong> — безопасные сделки с эскроу
          </span>
        </div>
        <nav className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Навигация в подвале">
          <Link href="/" className="hover:text-accentHover">
            Каталог
          </Link>
          <Link href="/listings/new" className="hover:text-accentHover">
            Разместить объявление
          </Link>
          <Link href="/favorites" className="hover:text-accentHover">
            Избранное
          </Link>
          <Link href="/orders" className="hover:text-accentHover">
            Заказы
          </Link>
        </nav>
      </div>
    </footer>
  );
}
