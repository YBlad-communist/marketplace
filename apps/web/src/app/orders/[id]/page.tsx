'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { ImageUploader } from '@/components/ImageUploader';
import { ReviewForm } from '@/components/ReviewForm';
import { get, post } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { OrderDto } from '@/lib/types';
import { cn, formatDateTime, formatPrice } from '@/lib/format';

const STATUS_LABEL: Record<OrderDto['status'], string> = {
  PENDING: 'Ожидает оплаты',
  PAID: 'Оплачен (удержан)',
  SHIPPED: 'Отправлен',
  RELEASING: 'Переводится',
  RELEASED: 'Завершён',
  REFUNDING: 'Возвращается',
  REFUNDED: 'Возвращён',
  DISPUTED: 'Спор',
};

const STATUS_EXPLANATION: Partial<Record<OrderDto['status'], string>> = {
  PENDING: 'Покупатель ещё не завершил оплату. Если она не будет выполнена, блокировка автоматически снимется.',
  PAID: 'Деньги заблокированы на карте покупателя и перейдут продавцу после подтверждения получения товара.',
  SHIPPED: 'Товар отправлен. Покупатель подтверждает получение — после этого деньги перейдут продавцу.',
  DISPUTED: 'По заказу открыт спор. Деньги удержаны, решение примет модератор.',
  RELEASED: 'Сделка завершена, деньги перечислены продавцу.',
  REFUNDED: 'Платёж возвращён покупателю.',
};

function formatRemain(ms: number): string {
  const hours = Math.ceil(ms / 3_600_000);
  if (hours >= 48) return `${Math.ceil(hours / 24)} дн.`;
  return `${Math.max(1, hours)} ч.`;
}

function HoldBanner({ holdExpiresAt }: { holdExpiresAt: string }) {
  const msLeft = new Date(holdExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return null;
  const urgent = msLeft <= 12 * 3_600_000;
  return (
    <div
      className={cn(
        'mt-4 rounded-lg border p-4 text-sm',
        urgent ? 'border-danger bg-danger/10 text-danger' : 'border-warning bg-warning/10 text-text'
      )}
    >
      <p className="font-medium">
        До окончания срока удержания оплаты — {formatRemain(msLeft)}
      </p>
      <p className="mt-1 text-textSecondary">
        Получили товар? Подтвердите получение — деньги перейдут продавцу. Если есть проблема,
        откройте спор. После окончания срока заказ уйдёт на проверку модератору.
      </p>
    </div>
  );
}

type StepState = 'done' | 'current' | 'todo';

/** Шкала шагов: Оплачено → Отправлено → Получено. */
function OrderSteps({ status }: { status: OrderDto['status'] }) {
  if (status === 'PENDING') {
    // Оплата ещё не завершена — шкала неактуальна, только статус.
    return null;
  }
  const states: Record<OrderDto['status'], [StepState, StepState, StepState]> = {
    PENDING: ['current', 'todo', 'todo'],
    PAID: ['done', 'current', 'todo'],
    SHIPPED: ['done', 'done', 'current'],
    RELEASING: ['done', 'done', 'done'],
    RELEASED: ['done', 'done', 'done'],
    REFUNDING: ['done', 'done', 'todo'],
    REFUNDED: ['done', 'todo', 'todo'],
    DISPUTED: ['done', 'done', 'current'],
  };
  const steps = [
    { label: 'Оплачено', hint: 'Деньги удержаны площадкой' },
    { label: 'Отправлено', hint: 'Продавец передал товар' },
    { label: 'Получено', hint: 'Подтверждение — деньги продавцу' },
  ];
  const [s0, s1, s2] = states[status];

  return (
    <ol className="mt-6 flex items-start gap-2" aria-label="Этапы сделки">
      {[
        { step: steps[0], state: s0 },
        { step: steps[1], state: s1 },
        { step: steps[2], state: s2 },
      ].map(({ step, state }, i) => (
        <li key={step.label} className="flex flex-1 items-start gap-2">
          {i > 0 && (
            <span
              aria-hidden
              className={cn('mt-4 h-0.5 flex-1 rounded', i === 1 && s1 === 'done' && s0 === 'done' ? 'bg-accent' : 'bg-border')}
            />
          )}
          <span className="flex min-w-0 flex-col items-center gap-1 text-center">
            <span
              aria-hidden
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                state === 'done' && 'bg-accent text-white',
                state === 'current' && 'border-2 border-accent bg-accentSoft text-accentHover',
                state === 'todo' && 'bg-surfaceMuted text-textMuted'
              )}
            >
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span className={cn('text-xs font-medium', state === 'todo' ? 'text-textMuted' : 'text-textPrimary')}>
              {step.label}
            </span>
            <span className="hidden text-[11px] leading-tight text-textMuted sm:block">{step.hint}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const [reviewing, setReviewing] = useState(false);
  const [shippingForm, setShippingForm] = useState(false);
  const [disputeForm, setDisputeForm] = useState(false);
  const [shipComment, setShipComment] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeComment, setDisputeComment] = useState('');
  const [disputePhotos, setDisputePhotos] = useState<{ key: string; position: number }[]>([]);
  const [disputeError, setDisputeError] = useState<string | null>(null);

  const orderQuery = useQuery({
    queryKey: ['order', params.id],
    queryFn: () => get<{ data: { order: OrderDto } }>(`/api/orders/${params.id}`),
  });

  const action = useMutation({
    mutationFn: (payload: { type: 'release' | 'refund' | 'ship' | 'dispute'; body?: unknown }) =>
      post(`/api/orders/${params.id}/${payload.type}`, payload.body),
    onSuccess: () => {
      setShippingForm(false);
      setDisputeForm(false);
      queryClient.invalidateQueries({ queryKey: ['order', params.id] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const order = orderQuery.data?.data.order;

  if (orderQuery.isLoading) {
    return (
      <div>
        <Header />
        <main className="mx-auto max-w-2xl px-4 py-10 text-textSecondary">Загрузка…</main>
      </div>
    );
  }

  if (!order) {
    return (
      <div>
        <Header />
        <main className="mx-auto max-w-2xl px-4 py-10 text-textSecondary">Заказ не найден</main>
      </div>
    );
  }

  const isBuyer = order.buyerId === userId;
  const isSeller = order.listing?.seller?.id === userId;
  const counterpartyId = isBuyer ? order.listing?.seller?.id : order.buyer?.id;

  const submitDispute = () => {
    const reason = disputeReason.trim();
    if (reason.length < 3) {
      setDisputeError('Опишите причину спора (минимум 3 символа)');
      return;
    }
    if (disputePhotos.length > 5) {
      setDisputeError('Не больше 5 фото');
      return;
    }
    setDisputeError(null);
    action.mutate({
      type: 'dispute',
      body: {
        reason,
        comment: disputeComment.trim() || undefined,
        photos: disputePhotos.map((p) => p.key),
      },
    });
  };

  const dispute = order.dispute;

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <Link href="/orders" className="mb-4 inline-block text-sm text-textSecondary hover:underline">
          ← Все заказы
        </Link>
        <div className="card p-6">
          <div className="flex items-start gap-4">
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-surfaceMuted">
              {order.listing?.images?.[0] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={order.listing.images[0].url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="flex-1">
              {order.listing && (
                <Link href={`/listings/${order.listing.id}`} className="text-lg font-semibold hover:text-accent">
                  {order.listing.title}
                </Link>
              )}
              <div className="mt-1 text-xl font-bold">{formatPrice(order.amount, order.currency)}</div>
              <div className="mt-1 text-sm text-textSecondary">Заказ от {formatDateTime(order.createdAt)}</div>
            </div>
          </div>

          <OrderSteps status={order.status} />

          <div className="mt-6 rounded-lg bg-surfaceMuted p-4">
            <div className="font-medium">{STATUS_LABEL[order.status]}</div>
            {STATUS_EXPLANATION[order.status] && (
              <p className="mt-1 text-sm text-textSecondary">{STATUS_EXPLANATION[order.status]}</p>
            )}
            {order.holdExpiresAt && ['PAID', 'SHIPPED'].includes(order.status) && (
              <p className="mt-1 text-xs text-textMuted">
                Срок холда: {formatDateTime(order.holdExpiresAt)}
              </p>
            )}
          </div>

          {isBuyer && ['PAID', 'SHIPPED'].includes(order.status) && order.holdExpiresAt && (
            <HoldBanner holdExpiresAt={order.holdExpiresAt} />
          )}

          {order.shippedAt && (
            <div className="mt-4 rounded-lg bg-surfaceMuted p-4 text-sm">
              <div className="font-medium">Отправлен {formatDateTime(order.shippedAt)}</div>
              {order.trackingNumber && (
                <div className="mt-1 text-textSecondary">Трек-номер: {order.trackingNumber}</div>
              )}
              {order.shipComment && <div className="mt-1 text-textSecondary">{order.shipComment}</div>}
            </div>
          )}

          {dispute && (
            <div className="mt-4 rounded-lg border border-warning bg-warning/10 p-4 text-sm">
              <div className="font-medium">
                Спор: {dispute.status === 'OPEN' ? 'ожидает решения модератора' : 'решён'}
              </div>
              <div className="mt-1 text-textSecondary">Причина: {dispute.reason}</div>
              {dispute.comment && <div className="mt-1 text-textSecondary">Комментарий: {dispute.comment}</div>}
              {dispute.resolutionComment && (
                <div className="mt-1 text-textSecondary">Решение: {dispute.resolutionComment}</div>
              )}
              {dispute.photos.length > 0 && (
                <div className="mt-2 grid grid-cols-5 gap-2">
                  {dispute.photos.map((url) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={url} src={url} alt="" className="aspect-square rounded object-cover" />
                  ))}
                </div>
              )}
            </div>
          )}

          {action.isError && (
            <p className="mt-3 text-sm text-danger">
              {action.error instanceof Error ? action.error.message : 'Не удалось выполнить действие'}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {isBuyer && order.status === 'PENDING' && (
              <button
                className="btn-secondary text-xs"
                onClick={() => action.mutate({ type: 'refund' })}
                disabled={action.isPending}
              >
                Отменить заказ
              </button>
            )}
            {isBuyer && (order.status === 'PAID' || order.status === 'SHIPPED') && (
              <button
                className="btn-primary text-xs"
                onClick={() => action.mutate({ type: 'release' })}
                disabled={action.isPending}
              >
                Подтвердить получение
              </button>
            )}
            {isBuyer && order.status === 'PAID' && (
              <button
                className="btn-secondary text-xs"
                onClick={() => action.mutate({ type: 'refund' })}
                disabled={action.isPending}
              >
                Запросить возврат
              </button>
            )}
            {isBuyer && order.status === 'SHIPPED' && !disputeForm && (
              <button className="btn-secondary text-xs" onClick={() => setDisputeForm(true)}>
                Открыть спор
              </button>
            )}
            {isSeller && order.status === 'PAID' && !shippingForm && (
              <button className="btn-primary text-xs" onClick={() => setShippingForm(true)}>
                Отправил / передал
              </button>
            )}
          </div>

          {isSeller && shippingForm && order.status === 'PAID' && (
            <form
              className="mt-4 space-y-3 rounded-lg bg-surfaceMuted p-4"
              onSubmit={(e) => {
                e.preventDefault();
                action.mutate({
                  type: 'ship',
                  body: {
                    comment: shipComment.trim() || undefined,
                    trackingNumber: trackingNumber.trim() || undefined,
                  },
                });
              }}
            >
              <div>
                <label className="mb-1 block text-xs text-textSecondary">
                  Комментарий (способ передачи, что и как отправлено)
                </label>
                <input
                  className="input"
                  value={shipComment}
                  onChange={(e) => setShipComment(e.target.value)}
                  maxLength={500}
                  placeholder="Например: передал лично, курьером, Почтой России"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-textSecondary">Трек-номер (необязательно)</label>
                <input
                  className="input"
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                  maxLength={64}
                />
              </div>
              <div className="flex gap-2">
                <button type="submit" className="btn-primary text-xs" disabled={action.isPending}>
                  {action.isPending ? 'Отправка…' : 'Подтвердить отправку'}
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => setShippingForm(false)}
                  disabled={action.isPending}
                >
                  Отмена
                </button>
              </div>
            </form>
          )}

          {isBuyer && disputeForm && order.status === 'SHIPPED' && (
            <div className="mt-4 space-y-3 rounded-lg bg-surfaceMuted p-4">
              <p className="text-sm font-medium">Открыть спор по заказу</p>
              <div>
                <label className="mb-1 block text-xs text-textSecondary">Причина спора *</label>
                <input
                  className="input"
                  value={disputeReason}
                  onChange={(e) => setDisputeReason(e.target.value)}
                  maxLength={300}
                  placeholder="Товар не пришёл, не соответствует описанию…"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-textSecondary">Подробности (необязательно)</label>
                <textarea
                  className="input min-h-[80px]"
                  value={disputeComment}
                  onChange={(e) => setDisputeComment(e.target.value)}
                  maxLength={2000}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-textSecondary">Фото (до 5)</label>
                <ImageUploader value={disputePhotos} onChange={setDisputePhotos} />
              </div>
              {disputeError && <p className="text-sm text-danger">{disputeError}</p>}
              <div className="flex gap-2">
                <button className="btn-primary text-xs" onClick={submitDispute} disabled={action.isPending}>
                  {action.isPending ? 'Отправка…' : 'Отправить спор'}
                </button>
                <button
                  className="btn-secondary text-xs"
                  onClick={() => setDisputeForm(false)}
                  disabled={action.isPending}
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

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
