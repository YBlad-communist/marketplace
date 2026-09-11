'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { post, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export default function SellerConnectPage() {
  const user = useAuthStore((s) => s.user);
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      post<{ data: { accountId: string; url: string | null } }>('/api/orders/seller/connect'),
    onSuccess: (res) => {
      if (res.data.url) {
        window.location.href = res.data.url;
      }
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить выплаты');
    },
  });

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-2xl font-bold">Подключение выплат</h1>

        <div className="card space-y-5 p-6">
          <p className="text-gray-700">
            Для получения оплаты по проданным объявлениям необходимо подключить аккаунт Stripe. Деньги
            покупателя хранятся на escrow-счёте и переводятся вам после подтверждения передачи.
          </p>

          {user?.stripeOnboarded ? (
            <div className="rounded-lg bg-green-100 p-4 text-sm text-green-700">
              Выплаты уже подключены.
            </div>
          ) : (
            <>
              <button
                className="btn-primary w-full"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
              >
                {connect.isPending ? 'Перенаправляем в Stripe…' : 'Подключить Stripe'}
              </button>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </>
          )}

          <div className="text-sm text-gray-500">
            <Link href="/cabinet" className="text-brand-600">
              ← Назад в кабинет
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
