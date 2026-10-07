'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { del, get, patch, post } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { cn, formatDate, formatDateTime, formatPrice } from '@/lib/format';

interface AdminListing {
  id: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  city: string;
  status: string;
  createdAt: string;
  seller: { id: string; name: string };
  images: { id: string; url: string; thumbUrl: string | null }[];
}

interface AdminReport {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  comment: string | null;
  status: string;
  createdAt: string;
  author: { id: string; name: string };
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  isBanned: boolean;
  isVerified: boolean;
  createdAt: string;
}

type Tab = 'listings' | 'reports' | 'users';

export default function AdminPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useState<Tab>('listings');

  const isStaff = user?.role === 'ADMIN' || user?.role === 'MODERATOR';
  const isAdmin = user?.role === 'ADMIN';
  const [actionError, setActionError] = useState<string | null>(null);

  const pendingQuery = useQuery({
    queryKey: ['admin-pending'],
    queryFn: () => get<{ data: { listings: AdminListing[] } }>('/api/admin/listings/pending'),
    enabled: isStaff && tab === 'listings',
  });

  const reportsQuery = useQuery({
    queryKey: ['admin-reports'],
    queryFn: () => get<{ data: { reports: AdminReport[] } }>('/api/admin/reports'),
    enabled: isStaff && tab === 'reports',
  });

  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => get<{ data: { users: AdminUser[] } }>('/api/admin/users'),
    enabled: isStaff && tab === 'users',
  });

  const moderate = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'APPROVE' | 'REJECT'; reason?: string }) =>
      post(`/api/admin/listings/${id}/moderate`, { listingId: id, action, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-pending'] }),
  });

  const resolveReport = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'RESOLVED' | 'DISMISSED' }) =>
      post(`/api/admin/reports/${id}/resolve`, { action }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-reports'] }),
  });

  const ban = useMutation({
    mutationFn: ({ id, banned, reason }: { id: string; banned: boolean; reason?: string }) =>
      post(`/api/admin/users/${id}/ban`, { userId: id, banned, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Не удалось изменить блокировку'),
  });

  // Смена роли и удаление аккаунта — только для администратора (на бэке
  // защищено requireAdmin; здесь — чисто визуальное разделение).
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'USER' | 'MODERATOR' }) =>
      patch(`/api/admin/users/${id}/role`, { userId: id, role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Не удалось изменить роль'),
  });

  const deleteUser = useMutation({
    mutationFn: (id: string) => del(`/api/admin/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Не удалось удалить аккаунт'),
  });

  const deleteListing = useMutation({
    mutationFn: (id: string) => del(`/api/listings/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-pending'] }),
  });

  if (!isStaff) {
    return (
      <div>
        <Header />
        <main className="container-x py-10 text-center text-textSecondary">Нет доступа к модерации</main>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'listings', label: 'На модерацию' },
    { id: 'reports', label: 'Жалобы' },
    { id: 'users', label: 'Пользователи' },
  ];

  return (
    <div>
      <Header />
      <main className="container-x py-8">
        <h1 className="section-title mb-6">Модерация</h1>

        {isStaff && (
          <div className="mb-6 flex flex-wrap gap-2">
            <Link href="/admin/categories" className="btn-secondary text-xs">
              Категории
            </Link>
            <Link href="/admin/locations" className="btn-secondary text-xs">
              Локации
            </Link>
          </div>
        )}

        <div className="mb-6 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Разделы модерации">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'btn-secondary text-xs',
                tab === t.id && '!border-accent !bg-accentSoft !text-accentHover'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {actionError && (
          <p className="mb-4 text-sm text-danger" role="alert">
            {actionError}
          </p>
        )}

        {tab === 'listings' && (
          <div className="space-y-3">
            {(pendingQuery.data?.data.listings ?? []).map((l) => (
              <div key={l.id} className="card flex flex-wrap items-center gap-4 p-4">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surfaceMuted">
                  {l.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.images[0].thumbUrl ?? l.images[0].url} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{l.title}</div>
                  <div className="truncate text-sm text-textSecondary">{l.description}</div>
                  <div className="text-xs text-textMuted">
                    {l.city} · {formatPrice(l.price, l.currency)} · {l.seller.name} · {formatDate(l.createdAt)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/listings/${l.id}`} className="btn-secondary text-xs">
                    Открыть
                  </Link>
                  <button className="btn-primary text-xs" onClick={() => moderate.mutate({ id: l.id, action: 'APPROVE' })}>
                    Одобрить
                  </button>
                  <button className="btn-danger text-xs" onClick={() => moderate.mutate({ id: l.id, action: 'REJECT', reason: 'Отклонено модератором' })}>
                    Отклонить
                  </button>
                  {isAdmin && (
                    <button
                      className="btn-danger text-xs"
                      disabled={deleteListing.isPending}
                      onClick={() => {
                        if (window.confirm('Удалить объявление безвозвратно?')) deleteListing.mutate(l.id);
                      }}
                    >
                      Удалить
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!pendingQuery.isLoading && (pendingQuery.data?.data.listings ?? []).length === 0 && (
              <div className="text-sm text-textSecondary">Нет объявлений на модерации</div>
            )}
          </div>
        )}

        {tab === 'reports' && (
          <div className="space-y-3">
            {(reportsQuery.data?.data.reports ?? []).map((r) => (
              <div key={r.id} className="card flex flex-wrap items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    Жалоба от {r.author.name} на {r.targetType.toLowerCase()}
                  </div>
                  <div className="text-sm text-textSecondary">Причина: {r.reason}</div>
                  {r.comment && <div className="text-xs text-textMuted">Комментарий: {r.comment}</div>}
                  <div className="mt-1 text-xs text-textMuted">{formatDateTime(r.createdAt)}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {r.targetType === 'LISTING' && (
                    <Link href={`/listings/${r.targetId}`} className="btn-secondary text-xs">
                      Открыть
                    </Link>
                  )}
                  <button className="btn-primary text-xs" onClick={() => resolveReport.mutate({ id: r.id, action: 'RESOLVED' })}>
                    Подтвердить
                  </button>
                  <button className="btn-secondary text-xs" onClick={() => resolveReport.mutate({ id: r.id, action: 'DISMISSED' })}>
                    Отклонить
                  </button>
                </div>
              </div>
            ))}
            {!reportsQuery.isLoading && (reportsQuery.data?.data.reports ?? []).length === 0 && (
              <div className="text-sm text-textSecondary">Нет новых жалоб</div>
            )}
          </div>
        )}

        {tab === 'users' && (
          <div className="space-y-3">
            {(usersQuery.data?.data.users ?? []).map((u) => {
              const isSelf = u.id === user?.id;
              const canManage = isAdmin && !isSelf && u.role !== 'ADMIN';
              return (
                <div key={u.id} className="card flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {u.name}
                      {u.role === 'MODERATOR' && (
                        <span className="ml-2 rounded-full bg-accentSoft px-2 py-0.5 text-[11px] text-accentHover">
                          модератор
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-textSecondary">{u.email}</div>
                    <div className="text-xs text-textMuted">
                      {u.role} · {u.isVerified ? 'подтверждён' : 'не подтверждён'} · {formatDate(u.createdAt)}
                      {u.isBanned && <span className="text-danger"> · заблокирован</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/users/${u.id}`} className="btn-secondary text-xs">
                      Профиль
                    </Link>
                    {u.role !== 'ADMIN' && !isSelf && (
                      <button
                        className={cn('text-xs', u.isBanned ? 'btn-primary' : 'btn-danger')}
                        onClick={() => ban.mutate({ id: u.id, banned: !u.isBanned, reason: u.isBanned ? undefined : 'Нарушение правил' })}
                      >
                        {u.isBanned ? 'Разблокировать' : 'Заблокировать'}
                      </button>
                    )}
                    {canManage && (
                      <button
                        className="btn-secondary text-xs"
                        disabled={changeRole.isPending}
                        onClick={() =>
                          changeRole.mutate({ id: u.id, role: u.role === 'MODERATOR' ? 'USER' : 'MODERATOR' })
                        }
                      >
                        {u.role === 'MODERATOR' ? 'Снять модератора' : 'Сделать модератором'}
                      </button>
                    )}
                    {canManage && (
                      <button
                        className="btn-danger text-xs"
                        disabled={deleteUser.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Удалить аккаунт «${u.name}» безвозвратно? Объявления, сообщения, отзывы и заказы будут удалены.`
                            )
                          ) {
                            deleteUser.mutate(u.id);
                          }
                        }}
                      >
                        Удалить аккаунт
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
