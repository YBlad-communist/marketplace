'use client';

import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ListingCard } from '@/components/ListingCard';
import { CardSkeleton, EmptyState, Pagination } from '@/components/ui/primitives';
import { get } from '@/lib/api';
import { CategoryDto, CursorPage, ListingDto, RegionDto } from '@/lib/types';
import { cn, plural } from '@/lib/format';

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

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" strokeLinecap="round" />
    </svg>
  );
}

/** Все фильтры живут в URL (?q=&cat=&region=&city=&cityName=&min=&max=&condition=&handover=&sort=). */
interface Filters {
  q: string;
  category: string;
  regionId: string;
  cityId: string;
  city: string;
  minPrice: string;
  maxPrice: string;
  condition: string;
  handover: string;
}

const EMPTY_FILTERS: Filters = {
  q: '',
  category: '',
  regionId: '',
  cityId: '',
  city: '',
  minPrice: '',
  maxPrice: '',
  condition: '',
  handover: '',
};

function filtersToParams(f: Filters, sort: string): URLSearchParams {
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.category) params.set('cat', f.category);
  if (f.regionId) params.set('region', f.regionId);
  if (f.cityId) params.set('city', f.cityId);
  if (f.city) params.set('cityName', f.city);
  if (f.minPrice) params.set('min', f.minPrice);
  if (f.maxPrice) params.set('max', f.maxPrice);
  if (f.condition) params.set('condition', f.condition);
  if (f.handover) params.set('handover', f.handover);
  if (sort !== 'date_desc') params.set('sort', sort);
  return params;
}

function HomeContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [city, setCity] = useState('');
  const [regionId, setRegionId] = useState('');
  const [cityId, setCityId] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [condition, setCondition] = useState('');
  const [handover, setHandover] = useState('');
  const [sort, setSort] = useState('date_desc');

  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // URL → state: один раз на изменение строки запроса. Свои коммиты помечаем
  // флагом, чтобы debounce-ввод не перетирался более старым значением из URL.
  const syncedUrl = useRef('');
  const selfCommit = useRef(false);
  useEffect(() => {
    const key = searchParams.toString();
    if (key === syncedUrl.current) return;
    syncedUrl.current = key;
    const external = !selfCommit.current;
    selfCommit.current = false;

    const qParam = searchParams.get('q') ?? '';
    const catParam = searchParams.get('cat') ?? searchParams.get('category') ?? '';
    const regionParam = searchParams.get('region') ?? '';
    const cityParam = searchParams.get('city') ?? '';
    const cityNameParam = searchParams.get('cityName') ?? '';
    const minParam = searchParams.get('min') ?? '';
    const maxParam = searchParams.get('max') ?? '';
    const conditionParam = searchParams.get('condition') ?? '';
    const handoverParam = searchParams.get('handover') ?? '';
    const sortParam = searchParams.get('sort') ?? 'date_desc';

    const next: Filters = {
      q: qParam.trim(),
      category: catParam,
      regionId: regionParam,
      cityId: cityParam,
      city: cityNameParam,
      minPrice: minParam,
      maxPrice: maxParam,
      condition: conditionParam,
      handover: handoverParam,
    };
    setAppliedFilters(next);
    if (external) {
      setQ(qParam);
      setCategory(catParam);
      setRegionId(regionParam);
      setCityId(cityParam);
      setCity(cityNameParam);
      setMinPrice(minParam);
      setMaxPrice(maxParam);
      setCondition(conditionParam);
      setHandover(handoverParam);
      setSort(sortParam);
    }
  }, [searchParams]);

  /** Единая точка коммита: применяем фильтры и записываем их в URL. */
  const commit = (next: Filters, nextSort: string = sort) => {
    setAppliedFilters(next);
    const qs = filtersToParams(next, nextSort).toString();
    if (qs === syncedUrl.current) return;
    selfCommit.current = true;
    router.replace(qs ? `/?${qs}` : '/');
  };

  // Debounce для свободного ввода (поиск/цены/город): 450 мс тишины → в URL.
  useEffect(() => {
    const draft: Filters = {
      ...appliedFilters,
      q: q.trim(),
      minPrice: minPrice.trim(),
      maxPrice: maxPrice.trim(),
      city: appliedFilters.cityId ? '' : city.trim(),
    };
    if (
      draft.q === appliedFilters.q &&
      draft.minPrice === appliedFilters.minPrice &&
      draft.maxPrice === appliedFilters.maxPrice &&
      draft.city === appliedFilters.city
    ) {
      return;
    }
    const timer = setTimeout(() => commit(draft), 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, minPrice, maxPrice, city]);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => get<{ data: { categories: CategoryDto[] } }>('/api/categories'),
    staleTime: 5 * 60_000,
  });
  const categories = categoriesQuery.data?.data.categories ?? [];

  const regionsQuery = useQuery({
    queryKey: ['regions'],
    queryFn: () => get<{ data: { regions: RegionDto[] } }>('/api/regions'),
    staleTime: 5 * 60_000,
  });
  const regions = regionsQuery.data?.data.regions ?? [];
  const selectedRegion = regions.find((r) => r.id === appliedFilters.regionId);

  const listingsQuery = useQuery({
    queryKey: ['listings', appliedFilters, sort],
    queryFn: () => {
      const params = new URLSearchParams({ sort, limit: '20' });
      if (appliedFilters.q) params.set('q', appliedFilters.q);
      if (appliedFilters.category) params.set('categoryId', appliedFilters.category);
      if (appliedFilters.regionId) params.set('regionId', appliedFilters.regionId);
      if (appliedFilters.cityId) params.set('cityId', appliedFilters.cityId);
      if (appliedFilters.city) params.set('city', appliedFilters.city);
      if (appliedFilters.minPrice) params.set('minPrice', appliedFilters.minPrice);
      if (appliedFilters.maxPrice) params.set('maxPrice', appliedFilters.maxPrice);
      if (appliedFilters.condition) params.set('condition', appliedFilters.condition);
      if (appliedFilters.handover) params.set('handover', appliedFilters.handover);
      return get<{ data: CursorPage<ListingDto> }>(`/api/listings?${params.toString()}`);
    },
  });

  const apply = () => {
    commit({
      q: q.trim(),
      category,
      regionId,
      cityId,
      city: regions.length > 0 ? '' : city.trim(),
      minPrice: minPrice.trim(),
      maxPrice: maxPrice.trim(),
      condition,
      handover,
    });
  };

  const pickCategory = (id: string) => {
    setCategory(id);
    commit({ ...appliedFilters, q: q.trim(), category: id });
  };

  const pickRegion = (id: string) => {
    setRegionId(id);
    setCityId('');
    commit({ ...appliedFilters, regionId: id, cityId: '', city: '' });
  };

  const pickCity = (id: string) => {
    setCityId(id);
    commit({ ...appliedFilters, cityId: id, city: '' });
  };

  const pickCondition = (value: string) => {
    setCondition(value);
    commit({ ...appliedFilters, condition: value });
  };

  const pickHandover = (value: string) => {
    setHandover(value);
    commit({ ...appliedFilters, handover: value });
  };

  const clearSearch = () => {
    setQ('');
    commit({ ...appliedFilters, q: '' });
  };

  const changeSort = (id: string) => {
    setSort(id);
    commit(appliedFilters, id);
  };

  const loadMore = async () => {
    const cursor = listingsQuery.data?.data.nextCursor;
    if (!cursor) return;
    const params = new URLSearchParams({ sort, limit: '20', cursor });
    if (appliedFilters.q) params.set('q', appliedFilters.q);
    if (appliedFilters.category) params.set('categoryId', appliedFilters.category);
    if (appliedFilters.regionId) params.set('regionId', appliedFilters.regionId);
    if (appliedFilters.cityId) params.set('cityId', appliedFilters.cityId);
    if (appliedFilters.city) params.set('city', appliedFilters.city);
    if (appliedFilters.minPrice) params.set('minPrice', appliedFilters.minPrice);
    if (appliedFilters.maxPrice) params.set('maxPrice', appliedFilters.maxPrice);
    if (appliedFilters.condition) params.set('condition', appliedFilters.condition);
    if (appliedFilters.handover) params.set('handover', appliedFilters.handover);
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
              <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
                <LockIcon />
                Безопасная сделка — эскроу
              </span>
              <h1 className="text-2xl font-bold leading-heading sm:text-3xl">Покупайте и продавайте рядом с вами</h1>
              <p className="mt-2 text-sm leading-body text-white/90 sm:text-base">
                {typeof total === 'number'
                  ? `Сейчас на площадке: ${total} ${plural(total, ['объявление', 'объявления', 'объявлений'])} — безопасные сделки с эскроу.`
                  : 'Свежие предложения со всей площадки — безопасные сделки с эскроу.'}
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

        {/* Как работает — 3 шага */}
        <section aria-label="Как работает безопасная сделка" className="mt-8">
          <h2 className="section-title text-xl">Как работает безопасная сделка</h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              {
                n: '1',
                title: 'Покупатель платит в эскроу',
                text: 'Деньги списываются с карты, но удерживаются площадкой — продавец их пока не получает.',
              },
              {
                n: '2',
                title: 'Продавец отдаёт товар',
                text: 'Самовывозом или доставкой — как договорились. Передачу он подтверждает на странице заказа.',
              },
              {
                n: '3',
                title: 'Покупатель подтверждает получение',
                text: 'Деньги сразу уходят продавцу. Если есть проблема — открывается спор, и решение принимает модератор.',
              },
            ].map((step) => (
              <li key={step.n} className="card p-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accentSoft text-sm font-bold text-accentHover">
                  {step.n}
                </span>
                <h3 className="mt-3 font-semibold">{step.title}</h3>
                <p className="mt-1 text-sm leading-body text-textSecondary">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Фильтры (поиск — в шапке, здесь только фильтры; состояние в URL) */}
        <section id="search" aria-label="Фильтры" className="card mt-6 scroll-mt-24 p-4">
          {appliedFilters.q && (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <span className="text-textSecondary">
                Поиск: <span className="font-medium text-textPrimary">«{appliedFilters.q}»</span>
              </span>
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Сбросить поиск"
                className="rounded-full bg-surfaceMuted px-2 text-xs text-textSecondary hover:text-danger"
              >
                ✕
              </button>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="sr-only" htmlFor="home-category">
                Категория
              </label>
              <select
                id="home-category"
                className="input"
                value={category}
                onChange={(e) => pickCategory(e.target.value)}
              >
                <option value="">Все категории</option>
                {categories.flatMap((c) => [
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>,
                  ...(c.children ?? []).flatMap((ch) => [
                    <option key={ch.id} value={ch.id}>
                      {c.name} — {ch.name}
                    </option>,
                    ...(ch.children ?? []).map((g) => (
                      <option key={g.id} value={g.id}>
                        {c.name} — {ch.name} — {g.name}
                      </option>
                    )),
                  ]),
                ])}
              </select>
            </div>
            <div>
              <label className="sr-only" htmlFor="home-condition">
                Состояние
              </label>
              <select
                id="home-condition"
                className="input"
                value={condition}
                onChange={(e) => pickCondition(e.target.value)}
              >
                <option value="">Любое состояние</option>
                <option value="NEW">Новый</option>
                <option value="USED">Б/у</option>
              </select>
            </div>
            <div>
              <label className="sr-only" htmlFor="home-handover">
                Способ получения
              </label>
              <select
                id="home-handover"
                className="input"
                value={handover}
                onChange={(e) => pickHandover(e.target.value)}
              >
                <option value="">Любой способ получения</option>
                <option value="PICKUP">Самовывоз</option>
                <option value="DELIVERY">Доставка</option>
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
              {regions.length > 0 ? (
                <>
                  <div>
                    <label className="sr-only" htmlFor="home-region">
                      Регион
                    </label>
                    <select
                      id="home-region"
                      className="input"
                      value={regionId}
                      onChange={(e) => pickRegion(e.target.value)}
                    >
                      <option value="">Все регионы</option>
                      {regions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="sr-only" htmlFor="home-city-select">
                      Город
                    </label>
                    <select
                      id="home-city-select"
                      className="input"
                      value={cityId}
                      onChange={(e) => pickCity(e.target.value)}
                      disabled={!selectedRegion}
                    >
                      <option value="">
                        {selectedRegion ? 'Все города' : 'Сначала регион'}
                      </option>
                      {(selectedRegion?.cities ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : (
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
              )}
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
            <SortChips sort={sort} onSort={changeSort} />
            <button type="button" className="btn-primary" onClick={apply}>
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
