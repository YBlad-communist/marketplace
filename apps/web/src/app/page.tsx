'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ListingCard } from '@/components/ListingCard';
import { get } from '@/lib/api';
import { CategoryDto, CursorPage, ListingDto } from '@/lib/types';
import { cn } from '@/lib/format';

function CardSkeleton() {
  return (
    <div className="card overflow-hidden" aria-hidden>
      <div className="skeleton aspect-[4/3] !rounded-none" />
      <div className="space-y-2 p-3">
        <div className="skeleton h-5 w-1/2" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-3 w-2/3" />
      </div>
    </div>
  );
}

export default function HomePage() {
  const queryClient = useQueryClient();

  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [city, setCity] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [sort, setSort] = useState('date_desc');

  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(Boolean(city || minPrice || maxPrice));

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => get<{ data: { categories: CategoryDto[] } }>('/api/categories'),
  });

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

  const apply = () => {
    setAppliedFilters({ q: q.trim(), category, city: city.trim(), minPrice: minPrice.trim(), maxPrice: maxPrice.trim() });
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

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="section-title">Объявления</h1>
        <p className="muted mt-1">
          {typeof total === 'number' ? `Найдено: ${total}` : 'Свежие предложения со всей площадки'}
        </p>

        <div className="card mt-4 p-4">
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
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Все категории</option>
                {(categoriesQuery.data?.data.categories ?? []).flatMap((c) => [
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
            className="mt-3 text-xs text-gray-500 hover:text-brand-600"
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
            <div className="flex gap-2 text-xs" role="group" aria-label="Сортировка">
              {[
                { id: 'date_desc', label: 'Сначала новые' },
                { id: 'price_asc', label: 'Дешевле' },
                { id: 'price_desc', label: 'Дороже' },
              ].map((s) => (
                <button
                  key={s.id}
                  aria-pressed={sort === s.id}
                  className={cn(
                    'rounded-full border px-3 py-1.5 transition-colors',
                    sort === s.id
                      ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                      : 'border-gray-300 text-gray-600 hover:border-gray-400'
                  )}
                  onClick={() => setSort(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <button className="btn-primary" onClick={apply}>
              Применить
            </button>
          </div>
        </div>

        {listingsQuery.isLoading && (
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <span className="sr-only" role="status">
              Загрузка объявлений
            </span>
            {Array.from({ length: 8 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        )}

        {listingsQuery.isError && (
          <div className="empty-state" role="alert">
            <p className="font-semibold">Не удалось загрузить объявления</p>
            <p className="muted mt-1">Проверьте соединение и попробуйте ещё раз</p>
            <button className="btn-secondary mt-4" onClick={() => listingsQuery.refetch()}>
              Повторить
            </button>
          </div>
        )}

        {!listingsQuery.isLoading && !listingsQuery.isError && (
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
        )}

        {!listingsQuery.isLoading && !listingsQuery.isError && items.length === 0 && (
          <div className="empty-state">
            <p className="font-semibold">Ничего не найдено</p>
            <p className="muted mt-1">Попробуйте изменить запрос или сбросить фильтры</p>
          </div>
        )}

        {listingsQuery.data?.data.nextCursor && (
          <div className="mt-8 flex justify-center">
            <button className="btn-secondary" onClick={loadMore}>
              Показать ещё
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
