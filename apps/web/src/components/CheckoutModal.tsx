'use client';

import { useEffect, useRef, useState } from 'react';
import { post } from '@/lib/api';
import { formatPrice } from '@/lib/format';

declare global {
  interface Window {
    YooMoneyCheckoutWidget?: new (options: {
      confirmation_token: string;
      return_url: string;
      error_callback?: (error: unknown) => void;
    }) => {
      render(containerId: string): void;
      destroy(): void;
    };
  }
}

interface Props {
  listingId: string;
  price: number;
  currency: string;
  onDone: () => void;
  onClose: () => void;
}

function loadWidgetScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.YooMoneyCheckoutWidget) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[src*="checkout-widget"]') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Не удалось загрузить платёжный виджет')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://yookassa.ru/checkout-widget/v1/checkout-widget.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Не удалось загрузить платёжный виджет'));
    document.head.appendChild(script);
  });
}

export function CheckoutModal({ listingId, price, currency, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<{ destroy: () => void } | null>(null);
  // Idempotency-ключ стабилен на время открытой модалки: повторный рендер
  // виджета не создаёт дубли заказов (при переоткрытии — новый ключ).
  const idempotencyKeyRef = useRef<string>(`ord-${crypto.randomUUID()}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await post<{ data: { order: { id: string }; confirmationToken: string } }>('/api/orders', {
          listingId,
          idempotencyKey: idempotencyKeyRef.current,
        });
        if (cancelled) return;
        await loadWidgetScript();
        if (cancelled) return;

        const widget = new window.YooMoneyCheckoutWidget!({
          confirmation_token: res.data.confirmationToken,
          return_url: `${window.location.origin}/orders/${res.data.order.id}`,
          error_callback: () => setError('Не удалось обработать платёж. Попробуйте ещё раз.'),
        });
        widgetRef.current = widget;
        widget.render('yoomoney-checkout');
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Ошибка создания заказа');
      }
    })();
    return () => {
      cancelled = true;
      widgetRef.current?.destroy();
      widgetRef.current = null;
    };
  }, [listingId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-semibold">Безопасная сделка</h3>
        <p className="mb-4 text-sm text-gray-600">
          {formatPrice(price, currency)} — деньги удерживаются платформой до подтверждения получения товара.
        </p>
        {status === 'loading' && <p className="text-sm text-gray-500">Подготавливаем оплату…</p>}
        {status === 'error' && <p className="mb-4 text-sm text-red-600">{error ?? 'Не удалось начать оплату'}</p>}
        {status === 'ready' && (
          <div id="yoomoney-checkout" ref={containerRef} className="min-h-[320px]" />
        )}
        {status === 'error' && (
          <button type="button" className="btn-secondary w-full" onClick={onClose}>
            Закрыть
          </button>
        )}
      </div>
    </div>
  );
}