import Link from 'next/link';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 text-sm text-gray-600 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white" aria-hidden>
            M
          </span>
          <span>
            <strong className="font-semibold text-gray-900">Marketplace</strong> — безопасные сделки с эскроу
          </span>
        </div>
        <nav className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Навигация в подвале">
          <Link href="/" className="hover:text-brand-700">
            Каталог
          </Link>
          <Link href="/listings/new" className="hover:text-brand-700">
            Разместить объявление
          </Link>
          <Link href="/favorites" className="hover:text-brand-700">
            Избранное
          </Link>
          <Link href="/orders" className="hover:text-brand-700">
            Заказы
          </Link>
        </nav>
      </div>
    </footer>
  );
}
