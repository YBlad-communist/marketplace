'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, StripeElementsOptions } from '@stripe/stripe-js';
import { useState } from 'react';
import { STRIPE_PUBLISHABLE_KEY, post } from '@/lib/api';
import { formatPrice } from '@/lib/format';

const stripePromise = STRIPE_PUBLISHABLE_KEY
  ? loadStripe(STRIPE_PUBLISHABLE_KEY)
  : Promise.resolve(null);

interface Props {
  listingId: string;
  price: number;
  currency: string;
  onDone: () => void;
  onClose: () => void;
}

function CheckoutForm({ listingId, price, currency, onDone, onClose }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  // Idempotency-ключ стабилен на время открытой модалки: даблклик не создаёт дубли заказов.
  const [idempotencyKey] = useState(() => `ord-${crypto.randomUUID()}`);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);
    const submitResult = await elements.submit().catch(() => null);
    if (submitResult && 'error' in submitResult && submitResult.error) {
      setError((submitResult.error as { message?: string }).message ?? 'Проверьте данные карты');
      setProcessing(false);
      return;
    }
    const res = await post<{ data: { clientSecret: string } }>('/api/orders', {
      listingId,
      idempotencyKey,
    }).catch((err: Error) => {
      setError(err.message);
      setProcessing(false);
      return null;
    });
    if (!res) return;

    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      clientSecret: res.data.clientSecret,
      confirmParams: { return_url: `${window.location.origin}/orders` },
      redirect: 'if_required',
    });
    if (confirmError) {
      setError(confirmError.message ?? 'Ошибка оплаты');
      setProcessing(false);
      return;
    }
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1" onClick={onClose} disabled={processing}>
          Отмена
        </button>
        <button className="btn-primary flex-1" disabled={!stripe || processing}>
          {processing ? 'Обработка…' : `Оплатить ${formatPrice(price, currency)}`}
        </button>
      </div>
    </form>
  );
}

export function CheckoutModal({ listingId, price, currency, onDone, onClose }: Props) {
  const options: StripeElementsOptions = {
    mode: 'payment',
    amount: Math.round(price * 100),
    currency: currency.toLowerCase(),
  };

  if (!STRIPE_PUBLISHABLE_KEY) {
    return (
      <div className="card fixed inset-0 z-50 m-auto flex h-fit max-w-md flex-col gap-4 p-6">
        <h3 className="text-lg font-semibold">Оплата недоступна</h3>
        <p className="text-sm text-gray-600">
          Stripe не настроен. Задайте <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code> и
          <code> STRIPE_SECRET_KEY</code> в .env.
        </p>
        <button className="btn-secondary" onClick={onClose}>
          Закрыть
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-lg font-semibold">Безопасная сделка</h3>
        <p className="mb-4 text-xs text-gray-500">
          Деньги удерживаются платформой до подтверждения получения товара.
        </p>
        <Elements stripe={stripePromise} options={options}>
          <CheckoutForm listingId={listingId} price={price} currency={currency} onDone={onDone} onClose={onClose} />
        </Elements>
      </div>
    </div>
  );
}
