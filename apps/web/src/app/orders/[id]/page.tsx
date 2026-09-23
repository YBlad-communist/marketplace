'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { ReviewForm } from '@/components/ReviewForm';
import { get, post } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { OrderDto } from '@/lib/types';
import { formatDateTime, formatPrice } from '@/lib/format';

const STATUS_LABEL: Record<OrderDto['status'], string> = {
  PENDING: 'Ожидает оплаты',
  PAID: 'Оплачен (удержан)',
  RELEASING: 'Переводится',
  RELEASED: 'Завершён',
  REFUNDING: 'Возвращается',
  REFUNDED: 'Возвращён',
  DISPUTED: 'Спор',
};

const STATUS_EXPLANATION: Partial<Record<OrderDto['status'], string>> = {
  PENDING: 'Покупатель ещё не завершил оплату. Если она не будет выполнена, блокировка автоматически снимется.',
  PAID: 'Деньги заблокированы на карте покупателя и перейдут продавцу после подтверждения получения товара.',
  DISPUTED: 'По заказу открыт спор с поддержкой. Мы свяжемся с вами и сообщим о результате.',
  RELEASED: 'Сделка завершена, деньги перечислены продавцу.',
  REFUNDED: 'Платёж возвращён покупателю.',
};

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const [reviewing, setReviewing] = useState(false);

  const orderQuery = useQuery({
    queryKey: ['order', params.id],
    queryFn: () => get<{ data: { order: OrderDto } }>(`/api/orders/${params.id}`),
  });

  const action = useMutation({
    mutationFn: (type: 'release' | 'refund') => post(`/api/orders/${params.id}/${type}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['order', params.id] }),
  });

  const order = orderQuery.data?.data.order;

  if (orderQuery.isLoading) {
    return (
      <div>
        <Header />
        <main className="mx-auto max-w-2xl px-4 py-10 text-gray-500">Загрузка…</main>
      </div>
    );
  }

  if (!order) {
    return (
      <div>
        <Header />
        <main className="mx-auto max-w-2xl px-4 py-10 text-gray-500">Заказ не найден</main>
      </div>
    );
  }

  const isBuyer = order.buyerId === userId;
  const isSeller = order.listing?.seller?.id === userId;
  const counterpartyId = isBuyer ? order.listing?.seller?.id : order.buyer?.id;

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <Link href="/orders" className="mb-4 inline-block text-sm text-gray-500 hover:underline">
          ← Все заказы
        </Link>
        <div className="card p-6">
          <div className="flex items-start gap-4">
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-gray-100">
              {order.listing?.images?.[0] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={order.listing.images[0].url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="flex-1">
              {order.listing && (
                <Link href={`/listings/${order.listing.id}`} className="text-lg font-semibold hover:text-brand-600">
                  {order.listing.title}
                </Link>
              )}
              <div className="mt-1 text-xl font-bold">{formatPrice(order.amount, order.currency)}</div>
              <div className="mt-1 text-sm text-gray-500">Заказ от {formatDateTime(order.createdAt)}</div>
            </div>
          </div>

          <div className="mt-6 rounded-lg bg-gray-50 p-4">
            <div className="font-medium">{STATUS_LABEL[order.status]}</div>
            {STATUS_EXPLANATION[order.status] && (
              <p className="mt-1 text-sm text-gray-600">{STATUS_EXPLANATION[order.status]}</p>
            )}
          </div>

          <div className="mt-4 flex gap-2">
            {isSeller && order.status === 'PAID' && (
              <button className="btn-primary text-xs" onClick={() => action.mutate('release')}>
                Подтвердить получение
              </button>
            )}
            {isBuyer && order.status === 'PENDING' && (
              <button className="btn-secondary text-xs" onClick={() => action.mutate('refund')}>
                Отменить заказ
              </button>
            )}
            {isBuyer && order.status === 'PAID' && (
              <button className="btn-secondary text-xs" onClick={() => action.mutate('refund')}>
                Запросить возврат
              </button>
            )}
          </div>

          {order.status === 'RELEASED' && !order.reviewedByMe && counterpartyId && (
            <div className="mt-4">
              {!reviewing ? (
                <button type="button" className="btn-secondary text-xs" onClick={() => setReviewing(true)}>
                  Оставить отзыв
                </button>
              ) : (
                <ReviewForm
                  orderId={order.id}
                  revieweeId={counterpartyId}
                  onCancel={() => setReviewing(false)}
                  onDone={() => {
                    setReviewing(false);
                    queryClient.invalidateQueries({ queryKey: ['order', params.id] });
                  }}
                />
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}