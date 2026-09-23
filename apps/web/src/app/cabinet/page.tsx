'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { VerifyPhoneButton } from '@/components/VerifyPhoneButton';
import { del, get, post, setAccessToken, ApiError } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { useAuthStore } from '@/lib/auth-store';
import { CursorPage, ListingDto } from '@/lib/types';
import { formatPrice } from '@/lib/format';
import { EmptyState, Tabs } from '@/components/ui/primitives';

export default function CabinetPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [editingProfile, setEditingProfile] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cabTab, setCabTab] = useState('listings');

  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'ACTIVE' | 'RESERVED' | 'SOLD' | 'PENDING' | 'REJECTED' | 'ARCHIVED'
  >('ALL');

  const myListingsQuery = useQuery({
    queryKey: ['my-listings', statusFilter],
    queryFn: () =>
      get<{ data: CursorPage<ListingDto> }>(
        `/api/listings?sellerId=${user?.id}&limit=50${statusFilter !== 'ALL' ? `&status=${statusFilter}` : ''}`
      ),
    enabled: Boolean(user?.id),
  });

  const remove = async (id: string) => {
    await del(`/api/listings/${id}`);
    router.refresh();
  };

  const deleteAccount = async () => {
    if (!deletePassword) {
      setDeleteError('Введите пароль для подтверждения');
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await del('/api/users/me', { password: deletePassword });
      await post('/api/auth/logout').catch(() => undefined);
      setAccessToken(null);
      disconnectSocket();
      setUser(null);
      router.push('/');
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Не удалось удалить аккаунт');
    } finally {
      setDeleting(false);
    }
  };

  if (!user) {
    return (
      <div>
        <Header />
        <main className="container-x py-8">
          <h1 className="mb-4 text-2xl font-bold">Личный кабинет</h1>
          <p className="text-textSecondary">
            Войдите, чтобы увидеть профиль.{' '}
            <Link href="/login" className="text-accent">
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
      <main className="container-x py-8">
        <h1 className="section-title mb-6">Личный кабинет</h1>

        <div className="card mb-8 p-5">
          {editingProfile ? (
            <ProfileEditForm onClose={() => setEditingProfile(false)} />
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-xl font-bold text-white"
                aria-hidden
              >
                {user?.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  (user?.name?.[0] ?? '?').toUpperCase()
                )}
              </div>
              <div>
                <div className="font-semibold">{user?.name}</div>
                <div className="text-sm text-textSecondary">{user?.email}</div>
                {user?.phone && <div className="text-sm text-textSecondary">{user.phone}</div>}
                <VerifyPhoneButton />
              </div>
              <div className="muted">
                Рейтинг: {typeof user?.rating === 'number' ? user.rating.toFixed(1) : '—'} ({user?.ratingCount ?? 0}{' '}
                отзывов)
              </div>
              <button type="button" className="btn-secondary text-xs" onClick={() => setEditingProfile(true)}>
                Редактировать профиль
              </button>
              {user?.yookassaOnboarded ? (
                <span className="badge-green">Выплаты подключены</span>
              ) : (
                <Link href="/seller/connect" className="btn-secondary text-xs">
                  Подключить выплаты (ЮKassa)
                </Link>
              )}
              <Link href="/cabinet/sessions" className="btn-secondary text-xs">
                Активные сессии
              </Link>
            </div>
          )}
        </div>

        <Tabs
          tabs={[
            { id: 'listings', label: 'Мои объявления' },
            { id: 'settings', label: 'Настройки' },
          ]}
          value={cabTab}
          onChange={setCabTab}
          ariaLabel="Разделы кабинета"
        />

        {cabTab === 'listings' ? (
        <div role="tabpanel" className="pt-4">
        <div className="mb-4 flex flex-wrap gap-2">
          {(['ALL', 'ACTIVE', 'RESERVED', 'SOLD', 'PENDING', 'REJECTED', 'ARCHIVED'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-xs ${statusFilter === s ? 'bg-accent text-white' : 'bg-surfaceMuted text-textSecondary'}`}
            >
              {
                {
                  ALL: 'Все',
                  ACTIVE: 'Активные',
                  RESERVED: 'Забронированы',
                  SOLD: 'Проданы',
                  PENDING: 'На модерации',
                  REJECTED: 'Отклонены',
                  ARCHIVED: 'Архив',
                }[s]
              }
            </button>
          ))}
        </div>
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
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surfaceMuted">
                {l.images[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.images[0].thumbUrl ?? l.images[0].url} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <Link href={`/listings/${l.id}`} className="block truncate font-medium hover:text-accent">
                  {l.title}
                </Link>
                <div className="text-sm text-textSecondary">
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
            <EmptyState
              title="Объявлений нет"
              action={
                <Link href="/listings/new" className="btn-primary text-xs">
                  Разместить первое
                </Link>
              }
            />
          )}
        </div>
        </div>
        ) : (
        <div role="tabpanel" className="space-y-4 pt-4">
          <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="font-medium">Активные сессии</div>
              <p className="muted mt-0.5">Устройства, где вы вошли в аккаунт</p>
            </div>
            <Link href="/cabinet/sessions" className="btn-secondary text-xs">
              Управление сессиями
            </Link>
          </div>

        <div className="rounded-2xl border border-danger/20 bg-danger/5 p-5">
          <h2 className="text-base font-semibold text-danger">Опасная зона</h2>
          <p className="mt-1 text-sm text-danger">
            Удаление аккаунта необратимо: объявления, сообщения, отзывы и файлы будут удалены безвозвратно.
            При активных заказах удаление недоступно.
          </p>
          {!deleteOpen ? (
            <button type="button" className="btn-danger mt-3 text-xs" onClick={() => setDeleteOpen(true)}>
              Удалить аккаунт
            </button>
          ) : (
            <div className="mt-3 max-w-sm">
              <label className="label" htmlFor="delete-password">
                Подтвердите паролем
              </label>
              <input
                id="delete-password"
                type="password"
                className="input"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                autoComplete="current-password"
              />
              {deleteError && <p className="mt-2 text-sm text-danger">{deleteError}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={deleting}
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeletePassword('');
                    setDeleteError(null);
                  }}
                >
                  Отмена
                </button>
                <button type="button" className="btn-danger text-xs" disabled={deleting} onClick={deleteAccount}>
                  {deleting ? 'Удаление…' : 'Удалить безвозвратно'}
                </button>
              </div>
            </div>
          )}
        </div>
        </div>
        )}
      </main>
    </div>
  );
}
