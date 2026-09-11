'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { post, setAccessToken, ApiError, API_URL } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export default function LoginPage() {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await post<{
        data: {
          user: Parameters<typeof setUser>[0];
          accessToken: string;
        };
      }>('/api/auth/login', { phone, password });
      setAccessToken(res.data.accessToken);
      setUser(res.data.user);
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка входа');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Header />
      <main className="mx-auto flex max-w-md flex-col px-4 py-16">
        <h1 className="section-title mb-6">Вход</h1>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="login-phone">
              Телефон
            </label>
            <input
              id="login-phone"
              className="input"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 (999) 000-00-00"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="login-password">
              Пароль
            </label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? 'Входим…' : 'Войти'}
          </button>
          <div className="text-sm text-gray-500">
            Нет аккаунта?{' '}
            <Link href="/register" className="text-brand-600">
              Зарегистрируйтесь
            </Link>
          </div>
          <div className="border-t pt-4">
            <a className="btn-secondary w-full" href={`${API_URL}/api/auth/oauth/google`}>
              Войти через Google
            </a>
          </div>
        </form>
      </main>
    </div>
  );
}
