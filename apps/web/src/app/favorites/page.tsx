'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ListingCard } from '@/components/ListingCard';
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
        <main className="mx-auto max-w-6xl px-4 py-10 text-center text-gray-500">
          <Link href="/login" className="text-brand-600">
            Войдите
          </Link>{' '}
          чтобы увидеть избранное
        </main>
      </div>
    );
  }

  const items = favoritesQuery.data?.data.items ?? [];

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Избранное</h1>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
        {!favoritesQuery.isLoading && items.length === 0 && (
          <div className="text-gray-500">
            В избранном пока пусто.{' '}
            <Link href="/" className="text-brand-600">
              Смотреть объявления
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
