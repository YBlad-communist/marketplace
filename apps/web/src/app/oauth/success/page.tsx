'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { get, post, setAccessToken } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import type { CurrentUser } from '@/lib/auth-store';

function OAuthSuccessInner() {
  const params = useSearchParams();
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Бэкенд отдаёт в URL только одноразовый code: меняем его на access-токен
    // через POST, чтобы токен не оседал в истории браузера и логах.
    const code = params.get('code');
    if (!code) {
      setError('Нет кода входа. Попробуйте войти снова.');
      return;
    }
    post<{ data: { accessToken: string } }>('/api/auth/oauth/exchange', { code })
      .then((r) => {
        setAccessToken(r.data.accessToken);
        return get<{ data: { user: CurrentUser } }>('/api/users/me');
      })
      .then((r) => {
        setUser(r.data.user);
        router.replace('/');
      })
      .catch(() => setError('Не удалось завершить вход через Google'));
  }, [params, router, setUser]);

  if (error) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="mb-2 text-xl font-bold">Ошибка входа</h1>
        <p className="text-sm text-red-600">{error}</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center text-gray-500">
      Завершаем вход через Google…
    </main>
  );
}

export default function OAuthSuccessPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-md px-4 py-16 text-center text-gray-500">Завершаем вход…</main>}>
      <OAuthSuccessInner />
    </Suspense>
  );
}
