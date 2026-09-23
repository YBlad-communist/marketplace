'use client';

import { useState } from 'react';
import { post, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export function PhoneChangeForm({ onDone }: { onDone: () => void }) {
  const setUser = useAuthStore((s) => s.setUser);
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const requestCode = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await post('/api/users/me/phone/request', { phone });
      setStep('code');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить код');
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await post<{ data: { user: Parameters<typeof setUser>[0] } }>('/api/users/me/phone/confirm', {
        phone,
        code,
      });
      setUser(res.data.user);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подтвердить телефон');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {step === 'phone' ? (
        <>
          <input
            className="input"
            type="tel"
            placeholder="Новый номер телефона"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="button" className="btn-primary text-xs" onClick={requestCode} disabled={submitting || !phone}>
            Получить код
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-textSecondary">Код отправлен на {phone}</p>
          <input
            className="input"
            inputMode="numeric"
            maxLength={6}
            placeholder="Код из SMS"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={confirm}
            disabled={submitting || code.length !== 6}
          >
            Подтвердить
          </button>
        </>
      )}
    </div>
  );
}