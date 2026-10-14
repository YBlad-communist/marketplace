'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { get, post, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

interface OnboardingField {
  name: string;
  label: string;
  placeholder?: string;
  help?: string;
}

interface OnboardingInfo {
  fields: OnboardingField[];
  steps: string[];
  actionLabel: string;
}

interface OnboardingResponse {
  provider: 'yookassa' | 'moneta' | 'mock';
  onboarding: OnboardingInfo;
  status: {
    payoutAccountId: string | null;
    payoutOnboarded: boolean;
    yookassaShopId: string | null;
    yookassaOnboarded: boolean;
  };
}

/**
 * Страница «Подключение выплат». Провайдер-нейтральная: поля/шаги/кнопка
 * приходят с сервера (getSellerOnboardingInfo активного провайдера), на
 * сервер уходит accountRef. Legacy-поля user.yookassa* сохранены в auth-store
 * для обратной совместимости.
 */
export default function SellerConnectPage() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [accountRef, setAccountRef] = useState(user?.yookassaShopId ?? '');
  const [error, setError] = useState<string | null>(null);

  const onboarding = useQuery({
    queryKey: ['seller-onboarding'],
    queryFn: () => get<{ data: OnboardingResponse }>('/api/orders/seller/onboarding'),
    staleTime: 60_000,
  });

  const info = onboarding.data?.data;
  const isConnected = info?.status.payoutOnboarded || info?.status.yookassaOnboarded;

  const connect = useMutation({
    mutationFn: (ref: string) =>
      post<{ data: { accountRef: string; shopId: string } }>('/api/orders/seller/connect', {
        accountRef: ref,
      }),
    onSuccess: async () => {
      setError(null);
      // Мутация меняет данные на сервере, но auth-store не знает об этом —
      // без перезапроса /me форма продолжит показывать себя как неподключённую
      // до ручной перезагрузки страницы. Тот же паттерн, что уже в Header.tsx.
      const me = await get<{ data: { user: Parameters<typeof setUser>[0] } }>('/api/users/me');
      setUser(me.data.user);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить реквизит счёта');
    },
  });

  const primaryField = info?.onboarding.fields[0];

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-2xl font-bold">Подключение выплат</h1>

        <div className="card space-y-5 p-6">
          {onboarding.isLoading && <p className="text-sm text-textSecondary">Загружаем настройки…</p>}
          {onboarding.isError && (
            <p className="text-sm text-danger">Не удалось загрузить настройки подключения.</p>
          )}

          {info && (
            <>
              <div className="text-sm text-textSecondary">
                Активный платёжный провайдер:{' '}
                <span className="font-medium text-textPrimary">
                  {info.provider === 'moneta'
                    ? 'Монета'
                    : info.provider === 'mock'
                      ? 'Тестовый (mock)'
                      : 'ЮKassa'}
                </span>
              </div>

              {isConnected ? (
                <div className="rounded-lg bg-accentSoft p-4 text-sm text-green-700">
                  Выплаты подключены
                  {(info.status.payoutAccountId || info.status.yookassaShopId) &&
                    ` (${info.status.payoutAccountId || info.status.yookassaShopId})`}
                  .
                </div>
              ) : (
                <>
                  <p className="text-textPrimary">
                    Для получения оплаты по проданным объявлениям укажите{' '}
                    {primaryField?.label ?? 'реквизит счёта продавца'}. Деньги покупателя
                    удерживаются платформой и переводятся вам после подтверждения получения.
                  </p>

                  {info.onboarding.steps.length > 0 && (
                    <ol className="list-decimal space-y-1 pl-5 text-sm text-textSecondary">
                      {info.onboarding.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  )}

                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (accountRef.trim()) connect.mutate(accountRef.trim());
                    }}
                  >
                    <label className="block">
                      <span className="mb-1 block text-sm text-textSecondary">
                        {primaryField?.label ?? 'Реквизит счёта'}
                      </span>
                      <input
                        className="input"
                        value={accountRef}
                        onChange={(e) => setAccountRef(e.target.value)}
                        placeholder={primaryField?.placeholder}
                        required
                      />
                      {primaryField?.help && (
                        <span className="mt-1 block text-xs text-textSecondary">{primaryField.help}</span>
                      )}
                    </label>
                    <button
                      className="btn-primary w-full"
                      disabled={connect.isPending || !accountRef.trim()}
                    >
                      {connect.isPending
                        ? 'Сохраняем…'
                        : (info.onboarding.actionLabel ?? 'Подключить выплаты')}
                    </button>
                    {error && <p className="text-sm text-danger">{error}</p>}
                  </form>
                </>
              )}
            </>
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
