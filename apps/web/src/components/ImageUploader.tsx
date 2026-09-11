'use client';

import { useEffect, useRef, useState } from 'react';
import { post, ApiError } from '@/lib/api';

interface PendingImage {
  localUrl: string;
  key: string;
  status: 'uploading' | 'done';
}

export function ImageUploader({
  value,
  onChange,
  onUploadingChange,
}: {
  value: { key: string; position: number }[];
  onChange: (keys: { key: string; position: number }[]) => void;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Актуальное значение для параллельных загрузок (избегаем stale closure).
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const activeUploads = useRef(0);
  const setUploading = (delta: number) => {
    activeUploads.current = Math.max(0, activeUploads.current + delta);
    onUploadingChange?.(activeUploads.current > 0);
  };

  const extFor = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() ?? 'jpg';
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(`.${ext}`) ? `.${ext}` : '.jpg';
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files).slice(0, 20)) {
      const mime = file.type;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
        setError('Допустимы только JPEG, PNG, WebP');
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        setError('Файл больше 5 МБ');
        continue;
      }
      const localUrl = URL.createObjectURL(file);
      const entry: PendingImage = { localUrl, key: '', status: 'uploading' };
      setPending((p) => [...p, entry]);
      setUploading(1);

      try {
        const presign = await post<{
          data: { key: string; uploadUrl: string };
        }>('/api/uploads/images/presign', {
          mime,
          extension: extFor(file.name),
          sizeBytes: file.size,
        });
        const res = await fetch(presign.data.uploadUrl, { method: 'PUT', body: file });
        if (!res.ok) throw new Error('Ошибка загрузки в S3');
        entry.key = presign.data.key;
        entry.status = 'done';
        setPending((p) => [...p]);
        // Функциональное обновление — без потери ключей при параллельных загрузках.
        const next = [...valueRef.current, { key: presign.data.key, position: valueRef.current.length }];
        valueRef.current = next;
        onChange(next);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Ошибка загрузки файла');
        setPending((p) => p.filter((x) => x !== entry));
        URL.revokeObjectURL(localUrl);
      } finally {
        setUploading(-1);
      }
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  const remove = (key: string) => {
    onChange(value.filter((v) => v.key !== key));
    setPending((p) => {
      const gone = p.find((x) => x.key === key);
      if (gone) URL.revokeObjectURL(gone.localUrl);
      return p.filter((x) => x.key !== key);
    });
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button type="button" className="btn-secondary" onClick={() => inputRef.current?.click()}>
        Добавить фото
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 grid grid-cols-4 gap-3">
        {pending.map((p, i) => (
          <div key={`${p.localUrl}-${i}`} className="relative aspect-square overflow-hidden rounded-lg bg-gray-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.localUrl} alt="" className="h-full w-full object-cover" />
            {p.status === 'uploading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
                Загрузка…
              </div>
            )}
            {p.status === 'done' && (
              <button
                type="button"
                className="absolute right-1 top-1 rounded-full bg-black/60 px-2 text-xs text-white"
                onClick={() => remove(p.key)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
