'use client';

import { useState } from 'react';
import { post, get, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export function VerifyPhoneButton() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!user || user.isVerified) return null;

  const requestCode = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await post('/api/auth/verification/request', { type: 'phone' });
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
      await post('/api/auth/verification/verify', { code });
      const me = await get<{ data: { user: Parameters<typeof setUser>[0] } }>('/api/users/me');
      setUser(me.data.user);
      setStep('idle');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Неверный код');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {step === 'idle' && (
        <button type="button" className="btn-secondary text-xs" onClick={requestCode} disabled={submitting}>
          Подтвердить телефон
        </button>
      )}
      {step === 'code' && (
        <div className="mt-2 flex items-center gap-2">
          <input
            className="input !w-32"
            inputMode="numeric"
            maxLength={6}
            placeholder="Код"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={confirm}
            disabled={submitting || code.length !== 6}
          >
            Подтвердить
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}