'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { post, ApiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'reset'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const requestCode = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await post('/api/auth/password/forgot', { phone });
      setStep('reset');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить код');
    } finally {
      setSubmitting(false);
    }
  };

  const resetPassword = async () => {
    if (newPassword !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await post('/api/auth/password/reset', { phone, code, newPassword });
      router.push('/login?reset=1');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сбросить пароль');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Header />
      <main className="mx-auto max-w-md px-4 py-10">
        <h1 className="mb-6 text-2xl font-bold">Восстановление пароля</h1>
        <div className="card space-y-4 p-6">
          {step === 'phone' ? (
            <>
              <div>
                <label className="label">Телефон</label>
                <input
                  className="input"
                  type="tel"
                  placeholder="+7 900 000-00-00"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-danger">{error}</p>}
              <button className="btn-primary w-full" onClick={requestCode} disabled={submitting || !phone}>
                {submitting ? 'Отправка…' : 'Получить код'}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-textSecondary">
                Если номер {phone} зарегистрирован — на него отправлен код подтверждения.
              </p>
              <div>
                <label className="label">Код из SMS</label>
                <input
                  className="input"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </div>
              <div>
                <label className="label">Новый пароль</label>
                <input
                  className="input"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Повторите пароль</label>
                <input
                  className="input"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-danger">{error}</p>}
              <button
                className="btn-primary w-full"
                onClick={resetPassword}
                disabled={submitting || code.length !== 6 || !newPassword}
              >
                {submitting ? 'Сохранение…' : 'Сохранить новый пароль'}
              </button>
              <button type="button" className="text-xs text-textSecondary hover:underline" onClick={() => setStep('phone')}>
                Изменить номер
              </button>
            </>
          )}
          <p className="text-center text-xs text-textSecondary">
            Вспомнили пароль?{' '}
            <Link href="/login" className="text-accent">
              Войти
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}