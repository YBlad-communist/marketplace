'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { CheckoutModal } from '@/components/CheckoutModal';
import { ListingCard } from '@/components/ListingCard';
import { Tabs } from '@/components/ui/primitives';
import { del, get, post, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { ListingDto } from '@/lib/types';
import { formatDate, formatPrice } from '@/lib/format';

function Gallery({ images, title }: { images: ListingDto['images']; title: string }) {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const img = images[active];
  return (
    <div>
      <div
        className="aspect-[4/3] cursor-zoom-in overflow-hidden rounded-2xl bg-surfaceMuted"
        onClick={() => img && setZoom(true)}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img.url} alt={title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-textSecondary">Нет фото</div>
        )}
      </div>
      {images.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Миниатюры фото">
          {images.map((i, idx) => (
            <button
              key={i.id}
              onClick={() => setActive(idx)}
              aria-label={`Фото ${idx + 1}`}
              aria-pressed={idx === active}
              className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 transition-all ${idx === active ? 'border-accent ring-2 ring-focus/30' : 'border-transparent opacity-70 hover:opacity-100'}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={i.thumbUrl ?? i.url} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
      {zoom && img && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setZoom(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Просмотр фото"
        >
          <button
            className="absolute right-4 top-4 rounded-full bg-surface/10 px-4 py-2 text-sm text-white hover:bg-surface/20"
            onClick={() => setZoom(false)}
            aria-label="Закрыть просмотр"
          >
            Закрыть ✕
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.url} alt={title} className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  );
}

function Attributes({ attributes }: { attributes: ListingDto['attributes'] }) {
  const entries = Object.entries(attributes ?? {}).filter(([, v]) => v !== null && v !== '');
  if (entries.length === 0) return null;
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-surfaceMuted px-3 py-2 text-sm">
          <dt className="text-textSecondary capitalize">{k}</dt>
          <dd className="font-medium">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function ListingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [infoTab, setInfoTab] = useState('desc');

  const listingQuery = useQuery({
    queryKey: ['listing', params.id],
    queryFn: () => get<{ data: { listing: ListingDto } }>(`/api/listings/${params.id}`),
  });
  const listing = listingQuery.data?.data.listing;

  const listingId = params.id;

  const favoriteMutation = useMutation({
    mutationFn: async () => {
      if (!user) {
        router.push('/login');
        return;
      }
      if (listing?.isFavorite) {
        await del(`/api/listings/${listingId}/favorite`);
      } else {
        await post(`/api/listings/${listingId}/favorite`);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['listing', params.id] }),
  });

  const startChat = async () => {
    if (!user) {
      router.push('/login');
      return;
    }
    try {
      const res = await post<{ data: { conversation: { id: string } } }>('/api/conversations', {
        listingId: params.id,
      });
      router.push(`/chat?conv=${res.data.conversation.id}`);
    } catch (err) {
      setChatError(err instanceof ApiError ? err.message : 'Не удалось начать чат');
    }
  };

  const [reportReason, setReportReason] = useState('SPAM');
  const [reportSent, setReportSent] = useState(false);

  const reportMutation = useMutation({
    mutationFn: () =>
      post('/api/reports', { targetType: 'LISTING', targetId: params.id, reason: reportReason }),
    onSuccess: () => setReportSent(true),
    onError: () => setChatError('Не удалось отправить жалобу'),
  });

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => del(`/api/listings/${listingId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['listing', params.id] });
      router.push('/');
    },
    onError: (err) => {
      setDeleteError(err instanceof ApiError ? err.message : 'Не удалось удалить объявление');
    },
  });

  const handleDelete = () => {
    setDeleteError(null);
    if (!window.confirm('Удалить объявление безвозвратно? Это действие нельзя отменить.')) return;
    deleteMutation.mutate();
  };

  if (listingQuery.isLoading) {
    return (
      <div>
        <Header />
        <main className="container-x py-6" aria-label="Загрузка объявления">
          <div className="skeleton h-4 w-1/3" />
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div className="skeleton aspect-[4/3]" />
            <div className="space-y-3">
              <div className="skeleton h-8 w-3/4" />
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton h-10 w-1/3" />
              <div className="skeleton h-24 w-full" />
            </div>
          </div>
        </main>
      </div>
    );
  }
  if (listingQuery.isError) {
    return (
      <div>
        <Header />
        <main className="container-x py-10">
          <div className="empty-state" role="alert">
            <p className="font-semibold">Не удалось загрузить объявление</p>
            <button className="btn-secondary mt-4" onClick={() => listingQuery.refetch()}>
              Повторить
            </button>
          </div>
        </main>
      </div>
    );
  }
  if (!listing) {
    return (
      <div>
        <Header />
        <main className="container-x py-10 text-center text-textSecondary">Объявление не найдено</main>
      </div>
    );
  }

  const isOwner = user?.id === listing.seller.id;
  const isStaff = user?.role === 'ADMIN' || user?.role === 'MODERATOR';
  const canDelete = isOwner || isStaff;
  const attrCount = Object.entries(listing.attributes ?? {}).filter(([, v]) => v !== null && v !== '').length;

  return (
    <div>
      <Header />
      <main className="container-x py-6">
        <nav className="muted-xs mb-4 flex flex-wrap items-center gap-1" aria-label="Хлебные крошки">
          <Link href="/" className="hover:text-accentHover">
            Каталог
          </Link>
          <span aria-hidden>/</span>
          {listing.category && (
            <>
              <span>{listing.category.name}</span>
              <span aria-hidden>/</span>
            </>
          )}
          <span className="max-w-64 truncate text-textPrimary" aria-current="page">
            {listing.title}
          </span>
        </nav>

        <div className="grid gap-6 lg:grid-cols-2">
          <Gallery images={listing.images} title={listing.title} />

          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{listing.title}</h1>
                <div className="muted-xs mt-1">
                  {listing.city} · {formatDate(listing.createdAt)} · {listing.viewsCount} просм.
                </div>
              </div>
              <button
                className="btn-secondary shrink-0"
                disabled={favoriteMutation.isPending}
                onClick={() => favoriteMutation.mutate()}
                aria-pressed={Boolean(listing.isFavorite)}
              >
                {listing.isFavorite ? 'В избранном ★' : 'В избранное ♡'}
              </button>
            </div>

            <div className="mt-4 text-3xl font-bold tracking-tight text-textPrimary">
              {formatPrice(listing.price, listing.currency)}
            </div>

            {listing.status === 'SOLD' && (
              <div className="mt-2">
                <span className="badge-gray">Продано</span>
              </div>
            )}

            <div className="mt-6">
              {attrCount > 0 ? (
                <>
                  <Tabs
                    tabs={[
                      { id: 'desc', label: 'Описание' },
                      { id: 'attrs', label: `Характеристики · ${attrCount}` },
                    ]}
                    value={infoTab}
                    onChange={setInfoTab}
                    ariaLabel="Информация об объявлении"
                  />
                  <div className="pt-4" role="tabpanel">
                    {infoTab === 'desc' ? (
                      <p className="whitespace-pre-line leading-body text-textPrimary">{listing.description}</p>
                    ) : (
                      <Attributes attributes={listing.attributes} />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <h2 className="mb-2 font-semibold">Описание</h2>
                  <p className="whitespace-pre-line text-textPrimary">{listing.description}</p>
                </>
              )}
            </div>

            {!isOwner && (
              <div className="mt-8 flex gap-3">
                <button className="btn-secondary flex-1" onClick={startChat}>
                  Написать продавцу
                </button>
                {listing.status === 'ACTIVE' && (
                  <button className="btn-primary flex-1" onClick={() => setCheckoutOpen(true)}>
                    Купить с эскроу
                  </button>
                )}
              </div>
            )}
            {chatError && <p className="mt-2 text-sm text-danger">{chatError}</p>}
            {canDelete && (
              <div className="mt-8 flex gap-3">
                {isOwner && (
                  <Link href={`/listings/${listing.id}/edit`} className="btn-secondary">
                    Редактировать
                  </Link>
                )}
                <button
                  className="btn-danger"
                  disabled={deleteMutation.isPending}
                  onClick={handleDelete}
                >
                  {deleteMutation.isPending ? 'Удаление…' : 'Удалить объявление'}
                </button>
              </div>
            )}
            {deleteError && (
              <p className="mt-2 text-sm text-danger" role="alert">
                {deleteError}
              </p>
            )}
            <div className="mt-4">
              {reportSent ? (
                <p className="muted-xs" role="status">
                  Жалоба отправлена на модерацию, спасибо
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor="report-reason">
                    Причина жалобы
                  </label>
                  <select
                    id="report-reason"
                    className="input !w-auto !py-1 text-xs"
                    value={reportReason}
                    onChange={(e) => setReportReason(e.target.value)}
                  >
                    <option value="SPAM">Спам</option>
                    <option value="FRAUD">Мошенничество</option>
                    <option value="INAPPROPRIATE">Неприемлемый контент</option>
                    <option value="OTHER">Другое</option>
                  </select>
                  <button
                    className="muted-xs underline decoration-border underline-offset-2 hover:text-danger"
                    disabled={reportMutation.isPending}
                    onClick={() => reportMutation.mutate()}
                  >
                    Пожаловаться
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-8">
          <h2 className="mb-4 font-semibold">Продавец</h2>
          <div className="card flex items-center gap-4 p-4">
            {listing.seller.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={listing.seller.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surfaceMuted text-lg font-bold">
                {listing.seller.name[0]}
              </div>
            )}
            <div>
              <div className="font-medium">
                <Link href={`/users/${listing.seller.id}`} className="hover:text-accent">
                  {listing.seller.name}
                </Link>
              </div>
              <div className="muted mt-1">
                Рейтинг:{' '}
                {typeof listing.seller.rating === 'number' ? listing.seller.rating.toFixed(1) : '—'} (
                {listing.seller.ratingCount} отзывов)
                {listing.seller.isVerified && <span className="badge-blue ml-2">подтверждён</span>}
              </div>
            </div>
          </div>
        </div>

        {listing.similar && listing.similar.length > 0 && (
          <div className="mt-10">
            <h2 className="mb-4 font-semibold">Похожие объявления</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {listing.similar.map((s) => (
                <ListingCard key={s.id} listing={s as ListingDto} />
              ))}
            </div>
          </div>
        )}
      </main>

      {checkoutOpen && (
        <CheckoutModal
          listingId={listing.id}
          price={listing.price}
          currency={listing.currency}
          onClose={() => setCheckoutOpen(false)}
          onDone={() => {
            setCheckoutOpen(false);
            router.push('/orders');
          }}
        />
      )}
    </div>
  );
}
