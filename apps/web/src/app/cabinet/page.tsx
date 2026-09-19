'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { del, get } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { CursorPage, ListingDto } from '@/lib/types';
import { formatPrice } from '@/lib/format';

export default function CabinetPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const myListingsQuery = useQuery({
    queryKey: ['my-listings'],
    queryFn: () =>
      get<{ data: CursorPage<ListingDto> }>(`/api/listings?sellerId=${user?.id}&status=ACTIVE&limit=50`),
    enabled: Boolean(user?.id),
  });

  const remove = async (id: string) => {
    await del(`/api/listings/${id}`);
    router.refresh();
  };

  if (!user) {
    return (
      <div>
        <Header />
        <main className="mx-auto max-w-6xl px-4 py-8">
          <h1 className="mb-4 text-2xl font-bold">Личный кабинет</h1>
          <p className="text-gray-500">
            Войдите, чтобы увидеть профиль.{' '}
            <Link href="/login" className="text-brand-600">
              Войти
            </Link>
          </p>
        </main>
      </div>
    );
  }

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="section-title mb-6">Личный кабинет</h1>

        <div className="card mb-8 p-5">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xl font-bold text-white" aria-hidden>
              {(user?.name?.[0] ?? '?').toUpperCase()}
            </div>
            <div>
              <div className="font-semibold">{user?.name}</div>
              <div className="text-sm text-gray-600">{user?.email}</div>
              {user?.phone && <div className="text-sm text-gray-600">{user.phone}</div>}
            </div>
            <div className="muted">
              Рейтинг: {typeof user?.rating === 'number' ? user.rating.toFixed(1) : '—'} ({user?.ratingCount ?? 0} отзывов)
            </div>
            {user?.stripeOnboarded ? (
              <span className="badge-green">Выплаты подключены</span>
            ) : (
              <Link href="/seller/connect" className="btn-secondary text-xs">
                Подключить выплаты (Stripe)
              </Link>
            )}
            <Link href="/cabinet/sessions" className="btn-secondary text-xs">
              Активные сессии
            </Link>
          </div>
        </div>

        <h2 className="mb-4 text-lg font-semibold">Мои объявления</h2>
        <div className="space-y-3">
          {myListingsQuery.isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card flex items-center gap-4 p-4" aria-hidden>
                <div className="skeleton h-16 w-16 !rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton h-3 w-1/3" />
                </div>
              </div>
            ))}
          {myListingsQuery.data?.data.items.map((l) => (
            <div key={l.id} className="card flex items-center gap-4 p-4">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-gray-100">
                {l.images[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.images[0].thumbUrl ?? l.images[0].url} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <Link href={`/listings/${l.id}`} className="block truncate font-medium hover:text-brand-600">
                  {l.title}
                </Link>
                <div className="text-sm text-gray-500">
                  {formatPrice(l.price, l.currency)} · {l.viewsCount} просмотров · {l.status}
                </div>
              </div>
              <div className="flex gap-2">
                <Link href={`/listings/${l.id}/edit`} className="btn-secondary text-xs">
                  Изменить
                </Link>
                <button className="btn-danger text-xs" onClick={() => remove(l.id)}>
                  Удалить
                </button>
              </div>
            </div>
          ))}
          {myListingsQuery.data?.data.items.length === 0 && (
            <div className="text-gray-500">
              Объявлений нет.{' '}
              <Link href="/listings/new" className="text-brand-600">
                Разместить первое
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
