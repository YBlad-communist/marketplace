'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ListingCard } from '@/components/ListingCard';
import { ReviewForm } from '@/components/ReviewForm';
import { get } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { CursorPage, ListingDto } from '@/lib/types';
import { formatDate, formatDateTime } from '@/lib/format';

interface PublicUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  city: string | null;
  rating: number;
  ratingCount: number;
  isVerified: boolean;
  createdAt: string;
}

interface ReviewDto {
  id: string;
  rating: number;
  text: string | null;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
}

function Stars({ value }: { value: number }) {
  return (
    <div className="text-sm font-bold text-amber-700" aria-label={`Рейтинг ${value.toFixed(1)} из 5`}>
      {'★'.repeat(Math.round(value))}
      <span className="text-border" aria-hidden="true">
        {'★'.repeat(5 - Math.round(value))}
      </span>
    </div>
  );
}

export default function UserProfilePage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const queryClient = useQueryClient();
  const meId = useAuthStore((s) => s.user?.id);
  const [reviewOpen, setReviewOpen] = useState(false);

  const userQuery = useQuery({
    queryKey: ['user', userId],
    queryFn: () => get<{ data: { user: PublicUser } }>(`/api/users/${userId}`),
  });

  const listingsQuery = useQuery({
    queryKey: ['user-listings', userId],
    queryFn: () => get<{ data: CursorPage<ListingDto> }>(`/api/listings?sellerId=${userId}&status=ACTIVE&limit=50`),
  });

  const reviewsQuery = useQuery({
    queryKey: ['user-reviews', userId],
    queryFn: () => get<{ data: { items: ReviewDto[]; nextCursor: string | null } }>(`/api/reviews?userId=${userId}&limit=20`),
  });

  const user = userQuery.data?.data.user;

  return (
    <div>
      <Header />
      <main className="container-x py-8">
        {userQuery.isLoading && <div className="text-center text-textSecondary">Загрузка…</div>}

        {user && (
          <div className="card mb-8 p-6">
            <div className="flex items-center gap-4">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surfaceMuted text-xl font-bold">
                  {user.name[0]}
                </div>
              )}
              <div>
                <h1 className="text-xl font-bold">
                  {user.name}
                  {user.isVerified && <span className="ml-2 rounded-full bg-info/10 px-2 py-0.5 text-xs text-sky-800">подтверждён</span>}
                </h1>
                <div className="text-sm text-textSecondary">
                  {user.city ?? 'Город не указан'} · на сайте с {formatDate(user.createdAt)}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Stars value={user.rating} />
                  <span className="text-sm text-textSecondary">
                    {user.rating.toFixed(1)} ({user.ratingCount} отзывов)
                  </span>
                </div>
                {meId && meId !== userId && (
                  <div className="mt-3">
                    {!reviewOpen ? (
                      <button type="button" className="btn-secondary text-xs" onClick={() => setReviewOpen(true)}>
                        Оставить отзыв
                      </button>
                    ) : (
                      <ReviewForm
                        revieweeId={userId}
                        onCancel={() => setReviewOpen(false)}
                        onDone={() => {
                          setReviewOpen(false);
                          void queryClient.invalidateQueries({ queryKey: ['user-reviews', userId] });
                          void queryClient.invalidateQueries({ queryKey: ['user', userId] });
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <h2 className="mb-4 text-lg font-semibold">Объявления</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {(listingsQuery.data?.data.items ?? []).map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
        {!listingsQuery.isLoading && (listingsQuery.data?.data.items ?? []).length === 0 && (
          <div className="text-textSecondary">Активных объявлений нет</div>
        )}

        <h2 className="mb-4 mt-10 text-lg font-semibold">Отзывы</h2>
        <div className="space-y-3">
          {(reviewsQuery.data?.data.items ?? []).map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.author.name}</span>
                <Stars value={r.rating} />
                <span className="ml-auto text-xs text-textMuted">{formatDateTime(r.createdAt)}</span>
              </div>
              {r.text && <p className="mt-2 text-sm text-textPrimary">{r.text}</p>}
            </div>
          ))}
          {!reviewsQuery.isLoading && (reviewsQuery.data?.data.items ?? []).length === 0 && (
            <div className="text-sm text-textSecondary">Отзывов пока нет</div>
          )}
        </div>
      </main>
    </div>
  );
}
