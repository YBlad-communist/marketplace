'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ReviewForm } from '@/components/ReviewForm';
import { get, post } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { OrderDto } from '@/lib/types';
import { cn, formatDateTime, formatPrice } from '@/lib/format';

const STATUS_LABEL: Record<OrderDto['status'], string> = {
  PENDING: 'Ожидает оплаты',
  PAID: 'Оплачен (эскроу)',
  RELEASING: 'Выплата',
  RELEASED: 'Завершён',
  REFUNDING: 'Возврат',
  REFUNDED: 'Возвращён',
  DISPUTED: 'Спор',
};

function OrderRow({
  order,
  role,
  onRelease,
  onRefund,
  onReviewed,
}: {
  order: OrderDto;
  role: 'buyer' | 'seller';
  onRelease: (id: string) => void;
  onRefund: (id: string) => void;
  onReviewed: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const counterpartyId = role === 'buyer' ? order.listing?.seller?.id : order.buyer?.id;

  return (
    <div className="card flex flex-wrap items-center gap-4 p-4">
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-gray-100">
        {order.listing?.images[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={order.listing.images[0].thumbUrl ?? order.listing.images[0].url} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        {order.listing && (
          <Link href={`/listings/${order.listing.id}`} className="block truncate font-medium hover:text-brand-600">
            {order.listing.title}
          </Link>
        )}
        <div className="text-sm text-gray-500">
          {role === 'seller' && order.buyer
            ? `Покупатель: ${order.buyer.name}`
            : order.listing?.seller
              ? `Продавец: ${order.listing.seller.name}`
              : null}
        </div>
        <div className="text-xs text-gray-400">{formatDateTime(order.createdAt)}</div>
        <Link href={`/orders/${order.id}`} className="text-xs text-gray-400 hover:text-brand-600 hover:underline">
          Подробнее →
        </Link>
      </div>
      <div className="font-semibold">{formatPrice(order.amount, order.currency)}</div>
      <span
        className={cn(
          order.status === 'RELEASED' && 'badge-green',
          order.status === 'REFUNDED' && 'badge-red',
          (order.status === 'PENDING' || order.status === 'RELEASING' || order.status === 'REFUNDING') && 'badge-gray',
          (order.status === 'PAID' || order.status === 'DISPUTED') && 'badge-amber'
        )}
      >
        {STATUS_LABEL[order.status]}
      </span>
      <div className="flex gap-2">
        {role === 'seller' && order.status === 'PAID' && (
          <button className="btn-primary text-xs" onClick={() => onRelease(order.id)}>
            Подтвердить передачу
          </button>
        )}
        {role === 'buyer' && order.status === 'PENDING' && (
          <button className="btn-secondary text-xs" onClick={() => onRefund(order.id)}>
            Отменить заказ
          </button>
        )}
        {role === 'buyer' && order.status === 'PAID' && (
          <button className="btn-secondary text-xs" onClick={() => onRefund(order.id)}>
            Запросить возврат
          </button>
        )}
        {order.status === 'RELEASED' && !order.reviewedByMe && counterpartyId && !reviewing && (
          <button className="btn-secondary text-xs" onClick={() => setReviewing(true)}>
            Оставить отзыв
          </button>
        )}
        {order.status === 'RELEASED' && order.reviewedByMe && (
          <span className="muted text-xs">Отзыв оставлен</span>
        )}
      </div>
      {reviewing && counterpartyId && (
        <div className="w-full">
          <ReviewForm
            orderId={order.id}
            revieweeId={counterpartyId}
            onCancel={() => setReviewing(false)}
            onDone={() => {
              setReviewing(false);
              onReviewed();
            }}
          />
        </div>
      )}
      {order.status === 'PAID' && (
        <p className="basis-full text-xs text-gray-500">
          {role === 'buyer'
            ? 'Деньги заблокированы на вашей карте и спишутся только после вашего подтверждения получения.'
            : 'Деньги заблокированы у покупателя. Вы получите их, когда сделка будет подтверждена.'}
        </p>
      )}
    </div>
  );
}

export default function OrdersPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const ordersQuery = useQuery({
    queryKey: ['orders'],
    queryFn: () =>
      get<{ data: { buyerOrders: OrderDto[]; sellerOrders: OrderDto[] } }>('/api/orders'),
    enabled: Boolean(user?.id),
  });

  const action = useMutation({
    mutationFn: ({ id, type }: { id: string; type: 'release' | 'refund' }) =>
      post(`/api/orders/${id}/${type}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  if (!user) {
    return (
      <div>
        <Header />
        <main className="mx-auto max-w-6xl px-4 py-10 text-center text-gray-500">
          <Link href="/login" className="text-brand-600">
            Войдите
          </Link>{' '}
          чтобы увидеть заказы
        </main>
      </div>
    );
  }

  const { buyerOrders = [], sellerOrders = [] } = ordersQuery.data?.data ?? {};

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="section-title mb-6">Заказы</h1>

        <h2 className="mb-3 text-lg font-semibold">
          Покупки{' '}
          {buyerOrders.length > 0 && <span className="muted font-normal">· {buyerOrders.length}</span>}
        </h2>
        <div className="space-y-3">
          {buyerOrders.length === 0 && <div className="text-sm text-gray-500">Покупок пока нет</div>}
          {buyerOrders.map((o) => (
            <OrderRow
              key={o.id}
              order={o}
              role="buyer"
              onRelease={() => undefined}
              onRefund={(id) => action.mutate({ id, type: 'refund' })}
              onReviewed={() => queryClient.invalidateQueries({ queryKey: ['orders'] })}
            />
          ))}
        </div>

        <h2 className="mb-3 mt-10 text-lg font-semibold">
          Продажи{' '}
          {sellerOrders.length > 0 && <span className="muted font-normal">· {sellerOrders.length}</span>}
        </h2>
        <div className="space-y-3">
          {sellerOrders.length === 0 && <div className="text-sm text-gray-500">Продаж пока нет</div>}
          {sellerOrders.map((o) => (
            <OrderRow
              key={o.id}
              order={o}
              role="seller"
              onRelease={(id) => action.mutate({ id, type: 'release' })}
              onRefund={() => undefined}
              onReviewed={() => queryClient.invalidateQueries({ queryKey: ['orders'] })}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
