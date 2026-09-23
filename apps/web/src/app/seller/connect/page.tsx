'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { get, post, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export default function SellerConnectPage() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [shopId, setShopId] = useState(user?.yookassaShopId ?? '');
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: (id: string) => post<{ data: { shopId: string } }>('/api/orders/seller/connect', { shopId: id }),
    onSuccess: async () => {
      setError(null);
      // Мутация меняет данные на сервере, но auth-store не знает об этом —
      // без перезапроса /me форма продолжит показывать себя как неподключённую
      // до ручной перезагрузки страницы. Тот же паттерн, что уже в Header.tsx.
      const me = await get<{ data: { user: Parameters<typeof setUser>[0] } }>('/api/users/me');
      setUser(me.data.user);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить Shop ID');
    },
  });

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-2xl font-bold">Подключение выплат</h1>

        <div className="card space-y-5 p-6">
          <p className="text-textPrimary">
            Для получения оплаты по проданным объявлениям укажите Shop ID вашего магазина ЮKassa
            (создайте магазин в личном кабинете ЮKassa и включите для него приём платежей). Деньги
            покупателя удерживаются платформой и переводятся вам после подтверждения получения.
          </p>

          {user?.yookassaOnboarded ? (
            <div className="rounded-lg bg-accentSoft p-4 text-sm text-green-700">
              Выплаты подключены{user.yookassaShopId ? ` (Shop ID: ${user.yookassaShopId})` : ''}.
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (shopId.trim()) connect.mutate(shopId.trim());
              }}
            >
              <label className="block">
                <span className="mb-1 block text-sm text-textSecondary">Shop ID магазина ЮKassa</span>
                <input
                  className="input"
                  value={shopId}
                  onChange={(e) => setShopId(e.target.value)}
                  placeholder="123456"
                  required
                />
              </label>
              <button className="btn-primary w-full" disabled={connect.isPending || !shopId.trim()}>
                {connect.isPending ? 'Сохраняем…' : 'Подключить ЮKassa'}
              </button>
              {error && <p className="text-sm text-danger">{error}</p>}
            </form>
          )}

          <div className="text-sm text-textSecondary">
            <Link href="/cabinet" className="text-accent">
              ← Назад в кабинет
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}