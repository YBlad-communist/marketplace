'use client';

import { useState } from 'react';
import { post, ApiError } from '@/lib/api';

export function ReviewForm({
  orderId,
  revieweeId,
  onDone,
  onCancel,
}: {
  // orderId опционален: отзыв с профиля продавца — без привязки к сделке.
  orderId?: string;
  revieweeId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await post('/api/reviews', { orderId, revieweeId, rating, text: text.trim() || undefined });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить отзыв');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-surfaceMuted p-4">
      <div className="mb-2 flex gap-1" role="radiogroup" aria-label="Оценка">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} из 5`}
            aria-pressed={rating === n}
            onClick={() => setRating(n)}
            className={`text-2xl leading-none ${n <= rating ? 'text-amber-500' : 'text-border'}`}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        className="input min-h-20"
        placeholder="Комментарий (необязательно)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
      />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-secondary text-xs" onClick={onCancel} disabled={submitting}>
          Отмена
        </button>
        <button type="button" className="btn-primary text-xs" onClick={submit} disabled={submitting}>
          {submitting ? 'Отправка…' : 'Отправить отзыв'}
        </button>
      </div>
    </div>
  );
}