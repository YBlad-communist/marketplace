'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ListingDto } from '@/lib/types';
import { del, post } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { cn, formatDate, formatPrice } from '@/lib/format';

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"
      />
    </svg>
  );
}

export function ListingCard({ listing }: { listing: ListingDto }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const image = listing.images?.[0];
  const isOwner = user?.id === listing.seller?.id;
  const isNew = Date.now() - new Date(listing.createdAt).getTime() < 7 * 24 * 3600_000;

  const favoriteMutation = useMutation({
    mutationFn: () =>
      listing.isFavorite
        ? del(`/api/listings/${listing.id}/favorite`)
        : post(`/api/listings/${listing.id}/favorite`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['listings'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      queryClient.invalidateQueries({ queryKey: ['listing', listing.id] });
      queryClient.invalidateQueries({ queryKey: ['user-listings'] });
    },
  });

  const toggleFavorite = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) {
      router.push('/login');
      return;
    }
    if (!favoriteMutation.isPending) favoriteMutation.mutate();
  };

  return (
    <div className="card card-hover group relative overflow-hidden">
      <Link href={`/listings/${listing.id}`} className="block" aria-label={listing.title}>
        <div className="relative aspect-[4/3] bg-surfaceMuted">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image.thumbUrl ?? image.url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-textMuted">Нет фото</div>
          )}
          {isNew && (
            <span className="badge-green absolute left-2 top-2 !px-2 shadow-sm">Новое</span>
          )}
        </div>
        <div className="p-3">
          <div className="text-lg font-bold leading-heading tracking-tight text-textPrimary">
            {formatPrice(listing.price, listing.currency ?? 'EUR')}
          </div>
          <div className="mt-0.5 line-clamp-2 min-h-10 text-sm leading-body text-textPrimary">{listing.title}</div>
          <div className="muted-xs mt-1.5 flex items-center justify-between gap-2">
            <span className="truncate">{listing.city}</span>
            <span className="shrink-0">{formatDate(listing.createdAt)}</span>
          </div>
        </div>
      </Link>
      {user && !isOwner && (
        <button
          type="button"
          onClick={toggleFavorite}
          aria-label={listing.isFavorite ? 'Убрать из избранного' : 'В избранное'}
          aria-pressed={Boolean(listing.isFavorite)}
          className={cn(
            'absolute right-2 top-2 rounded-full p-2 shadow-sm backdrop-blur transition-all',
            listing.isFavorite
              ? 'bg-accent text-white hover:bg-accentHover'
              : 'bg-surface/90 text-textSecondary hover:text-accent'
          )}
        >
          <HeartIcon filled={Boolean(listing.isFavorite)} />
        </button>
      )}
    </div>
  );
}
