'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { post, setAccessToken, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export default function RegisterPage() {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrors({});
    setGeneral(null);
    try {
      await post('/api/auth/register', {
        name,
        phone,
        password,
        confirmPassword: confirm,
      });
      const login = await post<{
        data: { user: Parameters<typeof setUser>[0]; accessToken: string };
      }>('/api/auth/login', { phone, password });
      setAccessToken(login.data.accessToken);
      setUser(login.data.user);
      router.push('/');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setErrors(err.fields);
      } else if (err instanceof ApiError) {
        setGeneral(err.message);
      } else {
        setGeneral('Ошибка регистрации');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Header />
      <main className="mx-auto flex max-w-md flex-col px-4 py-16">
        <h1 className="mb-6 text-2xl font-bold">Регистрация</h1>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <label className="label">Имя</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
          </div>
          <div>
            <label className="label">Телефон</label>
            <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 (999) 000-00-00" required />
            {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone}</p>}
          </div>
          <div>
            <label className="label">Пароль</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className="mt-1 text-xs text-gray-500">Минимум 8 символов, заглавная, строчная буква и цифра</p>
            {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password}</p>}
          </div>
          <div>
            <label className="label">Повторите пароль</label>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            {errors.confirmPassword && <p className="mt-1 text-xs text-red-600">{errors.confirmPassword}</p>}
          </div>
          {general && <p className="text-sm text-red-600">{general}</p>}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
          </button>
          <div className="text-sm text-gray-500">
            Уже есть аккаунт?{' '}
            <Link href="/login" className="text-brand-600">
              Войдите
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}
