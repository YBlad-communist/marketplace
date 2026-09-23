'use client';

import { useRef, useState } from 'react';
import { patch, post, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { PhoneChangeForm } from '@/components/PhoneChangeForm';

export function ProfileEditForm({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [name, setName] = useState(user?.name ?? '');
  const [city, setCity] = useState(user?.city ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [changingPhone, setChangingPhone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const saveBasics = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await patch<{ data: { user: Parameters<typeof setUser>[0] } }>('/api/users/me', { name, city });
      setUser(res.data.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSubmitting(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Допустимы только JPEG, PNG, WebP');
      return;
    }
    setUploadingAvatar(true);
    setError(null);
    try {
      const ext = `.${file.name.split('.').pop()?.toLowerCase() || 'jpg'}`;
      const presign = await post<{ data: { key: string; uploadUrl: string } }>('/api/uploads/images/presign', {
        mime: file.type,
        extension: ext,
        sizeBytes: file.size,
      });
      const uploadRes = await fetch(presign.data.uploadUrl, { method: 'PUT', body: file });
      if (!uploadRes.ok) throw new Error('Ошибка загрузки файла');
      const res = await post<{ data: { user: Parameters<typeof setUser>[0] } }>('/api/users/me/avatar/confirm', {
        key: presign.data.key,
      });
      setUser(res.data.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить фото');
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <div className="card space-y-4 p-5">
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-600 text-xl font-bold text-white">
          {user?.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            (user?.name?.[0] ?? '?').toUpperCase()
          )}
        </div>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])}
          />
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => fileRef.current?.click()}
            disabled={uploadingAvatar}
          >
            {uploadingAvatar ? 'Загрузка…' : 'Сменить фото'}
          </button>
        </div>
      </div>

      <div>
        <label className="label">Имя</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label">Город</label>
        <input className="input" value={city} onChange={(e) => setCity(e.target.value)} />
      </div>

      <div>
        <label className="label">Телефон</label>
        {!changingPhone ? (
          <div className="flex items-center gap-3">
            <span className="text-sm">{user?.phone}</span>
            <button
              type="button"
              className="text-xs text-brand-600 hover:underline"
              onClick={() => setChangingPhone(true)}
            >
              Изменить
            </button>
          </div>
        ) : (
          <PhoneChangeForm onDone={() => setChangingPhone(false)} />
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button type="button" className="btn-secondary text-xs" onClick={onClose}>
          Закрыть
        </button>
        <button type="button" className="btn-primary text-xs" onClick={saveBasics} disabled={submitting}>
          {submitting ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}