'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ListingCard } from '@/components/ListingCard';
import { EmptyState, CardSkeleton } from '@/components/ui/primitives';
import { get } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { CursorPage, ListingDto } from '@/lib/types';

export default function FavoritesPage() {
  const user = useAuthStore((s) => s.user);

  const favoritesQuery = useQuery({
    queryKey: ['favorites', user?.id],
    queryFn: () =>
      get<{ data: CursorPage<ListingDto> }>(`/api/listings?favoritesOf=${user?.id}&limit=50`),
    enabled: Boolean(user?.id),
  });

  if (!user) {
    return (
      <div>
        <Header />
        <main className="container-x py-8">
          <EmptyState
            icon="♡"
            title="Войдите, чтобы увидеть избранное"
            action={
              <Link href="/login" className="btn-primary text-sm">
                Войти
              </Link>
            }
          />
        </main>
      </div>
    );
  }

  const items = favoritesQuery.data?.data.items ?? [];

  return (
    <div>
      <Header />
      <main className="container-x py-8">
        <h1 className="section-title mb-6">Избранное</h1>
        {favoritesQuery.isLoading && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" role="status" aria-label="Загрузка избранного">
            {Array.from({ length: 4 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
        {!favoritesQuery.isLoading && items.length === 0 && (
          <EmptyState
            icon="♡"
            title="В избранном пока пусто"
            hint="Нажимайте на сердечко, чтобы сохранять объявления"
            action={
              <Link href="/" className="btn-secondary text-sm">
                Смотреть объявления
              </Link>
            }
          />
        )}
      </main>
    </div>
  );
}
