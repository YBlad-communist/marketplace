'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ListingCard } from '@/components/ListingCard';
import { CardSkeleton, EmptyState, Pagination } from '@/components/ui/primitives';
import { get } from '@/lib/api';
import { CategoryDto, CursorPage, ListingDto } from '@/lib/types';
import { cn } from '@/lib/format';

function SortChips({ sort, onSort }: { sort: string; onSort: (id: string) => void }) {
  return (
    <div className="flex gap-2 text-xs" role="group" aria-label="Сортировка">
      {[
        { id: 'date_desc', label: 'Сначала новые' },
        { id: 'price_asc', label: 'Дешевле' },
        { id: 'price_desc', label: 'Дороже' },
      ].map((s) => (
        <button
          key={s.id}
          type="button"
          aria-pressed={sort === s.id}
          className={cn(
            'rounded-full border px-3 py-1.5 transition-colors',
            sort === s.id
              ? 'border-accent bg-accentSoft font-medium text-accentActive'
              : 'border-border text-textSecondary hover:border-textMuted'
          )}
          onClick={() => onSort(s.id)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function HomeContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();

  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [city, setCity] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [sort, setSort] = useState('date_desc');

  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);

  // DECISION: шапка и плитки категорий ведут на /?q=../?cat=.. — синхронизируем
  // их со state один раз на изменение URL, логика запросов не меняется.
  const syncedUrl = useRef('');
  useEffect(() => {
    const key = searchParams.toString();
    if (key === syncedUrl.current) return;
    syncedUrl.current = key;
    const qParam = searchParams.get('q') ?? '';
    const catParam = searchParams.get('cat') ?? '';
    setQ(qParam);
    setCategory(catParam);
    setAppliedFilters({
      q: qParam.trim(),
      category: catParam,
      city: '',
      minPrice: '',
      maxPrice: '',
    });
  }, [searchParams]);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => get<{ data: { categories: CategoryDto[] } }>('/api/categories'),
    staleTime: 5 * 60_000,
  });
  const categories = categoriesQuery.data?.data.categories ?? [];

  const listingsQuery = useQuery({
    queryKey: ['listings', appliedFilters, sort],
    queryFn: () => {
      const params = new URLSearchParams({ sort, limit: '20' });
      if (appliedFilters.q) params.set('q', appliedFilters.q);
      if (appliedFilters.category) params.set('category', appliedFilters.category);
      if (appliedFilters.city) params.set('city', appliedFilters.city);
      if (appliedFilters.minPrice) params.set('minPrice', appliedFilters.minPrice);
      if (appliedFilters.maxPrice) params.set('maxPrice', appliedFilters.maxPrice);
      return get<{ data: CursorPage<ListingDto> }>(`/api/listings?${params.toString()}`);
    },
  });

  const apply = (next?: { q?: string; category?: string }) => {
    setAppliedFilters({
      q: (next?.q ?? q).trim(),
      category: next?.category ?? category,
      city: city.trim(),
      minPrice: minPrice.trim(),
      maxPrice: maxPrice.trim(),
    });
  };

  const pickCategory = (id: string) => {
    setCategory(id);
    setAppliedFilters({
      q: q.trim(),
      category: id,
      city: city.trim(),
      minPrice: minPrice.trim(),
      maxPrice: maxPrice.trim(),
    });
  };

  const loadMore = async () => {
    const cursor = listingsQuery.data?.data.nextCursor;
    if (!cursor) return;
    const params = new URLSearchParams({ sort, limit: '20', cursor });
    if (appliedFilters.q) params.set('q', appliedFilters.q);
    if (appliedFilters.category) params.set('category', appliedFilters.category);
    if (appliedFilters.city) params.set('city', appliedFilters.city);
    if (appliedFilters.minPrice) params.set('minPrice', appliedFilters.minPrice);
    if (appliedFilters.maxPrice) params.set('maxPrice', appliedFilters.maxPrice);
    const page = await get<{ data: CursorPage<ListingDto> }>(`/api/listings?${params.toString()}`);
    queryClient.setQueryData<{ data: CursorPage<ListingDto> }>(['listings', appliedFilters, sort], (old) => ({
      data: old
        ? { ...page.data, items: [...old.data.items, ...page.data.items] }
        : page.data,
    }));
  };

  const items = listingsQuery.data?.data.items ?? [];
  const total = listingsQuery.data?.data.total;
  const recommended = items.slice(0, 10);

  return (
    <div>
      <Header />
      <main className="container-x py-6">
        {/* Hero */}
        <section className="overflow-hidden rounded-2xl bg-gradient-to-r from-accentActive via-accent to-accentHover text-white shadow-card">
          <div className="flex flex-col gap-4 p-6 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-xl">
              <h1 className="text-2xl font-bold leading-heading sm:text-3xl">Покупайте и продавайте рядом с вами</h1>
              <p className="mt-2 text-sm leading-body text-white/90 sm:text-base">
                {typeof total === 'number' ? `Сейчас на площадке: ${total}` : 'Свежие предложения со всей площадки'} — безопасные сделки с эскроу.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Link href="/listings/new" className="rounded-lg bg-surface px-5 py-2.5 text-sm font-semibold text-accentActive shadow-sm transition-transform hover:scale-[1.02]">
                Разместить объявление
              </Link>
              <a href="#fresh" className="rounded-lg border border-white/40 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-surface/10">
                Смотреть каталог
              </a>
            </div>
          </div>
        </section>

        {/* Плитки категорий */}
        {categories.length > 0 && (
          <section aria-label="Категории" className="mt-6">
            <div className="nice-scroll flex gap-3 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => pickCategory('')}
                aria-pressed={category === ''}
                className={cn(
                  'flex w-28 shrink-0 flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition-all',
                  category === ''
                    ? 'border-accent bg-accentSoft font-medium text-accentActive'
                    : 'border-border bg-surface text-textSecondary hover:border-textMuted'
                )}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surfaceMuted text-lg" aria-hidden>
                  ★
                </span>
                <span className="line-clamp-2 text-xs leading-tight">Все</span>
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pickCategory(c.id)}
                  aria-pressed={category === c.id}
                  className={cn(
                    'flex w-28 shrink-0 flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition-all',
                    category === c.id
                      ? 'border-accent bg-accentSoft font-medium text-accentActive'
                      : 'border-border bg-surface text-textSecondary hover:border-textMuted'
                  )}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surfaceMuted text-lg" aria-hidden>
                    {c.icon ?? (c.name[0] ?? '•').toUpperCase()}
                  </span>
                  <span className="line-clamp-2 text-xs leading-tight">{c.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Поиск и фильтры */}
        <section id="search" aria-label="Поиск и фильтры" className="card mt-6 scroll-mt-24 p-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="sr-only" htmlFor="home-search">
                Поиск по объявлениям
              </label>
              <input
                id="home-search"
                className="input"
                placeholder="Поиск: смартфон, квартира…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
              />
            </div>
            <div>
              <label className="sr-only" htmlFor="home-category">
                Категория
              </label>
              <select
                id="home-category"
                className="input"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  apply({ category: e.target.value });
                }}
              >
                <option value="">Все категории</option>
                {categories.flatMap((c) => [
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>,
                  ...(c.children ?? []).map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {c.name} — {ch.name}
                    </option>
                  )),
                ])}
              </select>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className="mt-3 text-xs text-textSecondary hover:text-accentHover"
            aria-expanded={filtersOpen}
            aria-controls="home-extra-filters"
          >
            {filtersOpen ? 'Свернуть фильтры ⌃' : 'Ещё фильтры ⌄'}
          </button>

          {filtersOpen && (
            <div id="home-extra-filters" className="mt-3 grid gap-3 md:grid-cols-3">
              <div>
                <label className="sr-only" htmlFor="home-city">
                  Город
                </label>
                <input
                  id="home-city"
                  className="input"
                  placeholder="Город"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="sr-only" htmlFor="home-min">
                    Цена от
                  </label>
                  <input
                    id="home-min"
                    className="input"
                    placeholder="от"
                    inputMode="numeric"
                    value={minPrice}
                    onChange={(e) => setMinPrice(e.target.value)}
                  />
                </div>
                <div className="flex-1">
                  <label className="sr-only" htmlFor="home-max">
                    Цена до
                  </label>
                  <input
                    id="home-max"
                    className="input"
                    placeholder="до"
                    inputMode="numeric"
                    value={maxPrice}
                    onChange={(e) => setMaxPrice(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <SortChips sort={sort} onSort={setSort} />
            <button type="button" className="btn-primary" onClick={() => apply()}>
              Применить
            </button>
          </div>
        </section>

        {/* Рекомендации */}
        {!listingsQuery.isLoading && !listingsQuery.isError && recommended.length > 0 && (
          <section aria-label="Рекомендации" className="mt-8">
            <h2 className="section-title text-xl">Рекомендации</h2>
            <div className="nice-scroll -mx-4 mt-4 flex snap-x gap-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
              {recommended.map((l) => (
                <div key={l.id} className="w-44 shrink-0 snap-start sm:w-52">
                  <ListingCard listing={l} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Свежие */}
        <section id="fresh" aria-label="Свежие объявления" className="mt-8 scroll-mt-24">
          <h2 className="section-title text-xl">Свежие объявления</h2>

          {listingsQuery.isLoading && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <span className="sr-only" role="status">
                Загрузка объявлений
              </span>
              {Array.from({ length: 8 }).map((_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          )}

          {listingsQuery.isError && (
            <EmptyState
              title="Не удалось загрузить объявления"
              hint="Проверьте соединение и попробуйте ещё раз"
              action={
                <button type="button" className="btn-secondary" onClick={() => listingsQuery.refetch()}>
                  Повторить
                </button>
              }
            />
          )}

          {!listingsQuery.isLoading && !listingsQuery.isError && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </div>
          )}

          {!listingsQuery.isLoading && !listingsQuery.isError && items.length === 0 && (
            <EmptyState title="Ничего не найдено" hint="Попробуйте изменить запрос или сбросить фильтры" />
          )}

          <Pagination hasMore={Boolean(listingsQuery.data?.data.nextCursor)} onMore={loadMore} />
        </section>
      </main>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="container-x py-6 text-textMuted">Загрузка…</div>}>
      <HomeContent />
    </Suspense>
  );
}
