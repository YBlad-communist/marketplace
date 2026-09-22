'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, get, post, patch } from '@/lib/api';
import { ImageUploader } from '@/components/ImageUploader';
import { ExistingImagesEditor } from '@/components/ExistingImagesEditor';
import { CategoryAttributeDto, CategoryDto, ListingDto } from '@/lib/types';

interface Props {
  mode: 'create' | 'edit';
  initial?: ListingDto;
}

function attributeInput(
  attr: CategoryAttributeDto,
  value: string,
  setValue: (v: string) => void
) {
  switch (attr.type) {
    case 'SELECT': {
      const options = (Array.isArray(attr.options) ? attr.options : []) as string[];
      return (
        <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">—</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    case 'BOOLEAN':
      return (
        <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">—</option>
          <option value="true">Да</option>
          <option value="false">Нет</option>
        </select>
      );
    case 'NUMBER':
    case 'RANGE':
      return (
        <input
          className="input"
          type="number"
          min={attr.min ?? undefined}
          max={attr.max ?? undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    default:
      return <input className="input" value={value} onChange={(e) => setValue(e.target.value)} />;
  }
}

export function ListingForm({ mode, initial }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [price, setPrice] = useState(initial ? String(initial.price) : '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [categoryId, setCategoryId] = useState(initial?.category?.id ?? '');
  const [attributeValues, setAttributeValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(initial?.attributes ?? {}).map(([k, v]) => [k, String(v)]))
  );
  const [imageKeys, setImageKeys] = useState<{ key: string; position: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => get<{ data: { categories: CategoryDto[] } }>('/api/categories'),
  });

  const selectedCategory = (categoriesQuery.data?.data.categories ?? [])
    .flatMap((c) => [c, ...(c.children ?? [])])
    .find((c) => c.id === categoryId);

  const attributes = selectedCategory?.attributes ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (uploading) {
      setGeneral('Дождитесь окончания загрузки фото');
      return;
    }
    setSubmitting(true);
    setErrors({});
    setGeneral(null);

    const attrsPayload: Record<string, string | number | boolean> = {};
    for (const attr of attributes) {
      const raw = attributeValues[attr.key];
      if (raw === undefined || raw === '') continue;
      if (attr.type === 'NUMBER' || attr.type === 'RANGE') attrsPayload[attr.key] = Number(raw);
      else if (attr.type === 'BOOLEAN') attrsPayload[attr.key] = raw === 'true';
      else attrsPayload[attr.key] = raw;
    }

    const body = {
      title,
      description,
      price: Number(price),
      currency: 'RUB',
      categoryId,
      city,
      attributes: attrsPayload,
      imageKeys,
    };

    try {
      if (mode === 'create') {
        await post('/api/listings', body);
        router.push('/');
      } else if (initial) {
        await patch(`/api/listings/${initial.id}`, { ...body, imageKeys: undefined });
        router.push(`/listings/${initial.id}`);
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setErrors(err.fields);
        setGeneral(err.message);
      } else if (err instanceof ApiError) {
        setGeneral(err.message);
      } else {
        setGeneral('Ошибка сохранения');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-5 p-6">
      <div>
        <label className="label">Название *</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        {errors.title && <p className="mt-1 text-xs text-red-600">{errors.title}</p>}
      </div>

      <div>
        <label className="label">Описание *</label>
        <textarea
          className="input min-h-32"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        {errors.description && <p className="mt-1 text-xs text-red-600">{errors.description}</p>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="label">Цена (₽) *</label>
          <input
            className="input"
            type="number"
            min="0.01"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
          {errors.price && <p className="mt-1 text-xs text-red-600">{errors.price}</p>}
        </div>
        <div>
          <label className="label">Город *</label>
          <input className="input" value={city} onChange={(e) => setCity(e.target.value)} required />
        </div>
      </div>

      <div>
        <label className="label">Категория *</label>
        <select
          className="input"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            // Сбрасываем атрибуты при смене категории, иначе отправятся чужие ключи.
            setAttributeValues({});
          }}
          required
        >
          <option value="">Выберите категорию</option>
          {(categoriesQuery.data?.data.categories ?? []).map((c) => (
            <optgroup key={c.id} label={c.name}>
              <option value={c.id}>{c.name}</option>
              {(c.children ?? []).map((ch) => (
                <option key={ch.id} value={ch.id}>
                  — {ch.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {errors.categoryId && <p className="mt-1 text-xs text-red-600">{errors.categoryId}</p>}
      </div>

      {attributes.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {attributes.map((attr) => (
            <div key={attr.id}>
              <label className="label">
                {attr.label}
                {attr.unit ? `, ${attr.unit}` : ''}
                {attr.required ? ' *' : ''}
              </label>
              {attributeInput(attr, attributeValues[attr.key] ?? '', (v) =>
                setAttributeValues((s) => ({ ...s, [attr.key]: v }))
              )}
            </div>
          ))}
        </div>
      )}

      {mode === 'create' ? (
        <div>
          <label className="label">Фотографии</label>
          <ImageUploader value={imageKeys} onChange={setImageKeys} onUploadingChange={setUploading} />
          {errors.imageKeys && <p className="mt-1 text-xs text-red-600">{errors.imageKeys}</p>}
        </div>
      ) : (
        <div>
          <label className="label">Фотографии</label>
          <ExistingImagesEditor listingId={initial!.id} />
        </div>
      )}

      {general && <p className="text-sm text-red-600">{general}</p>}

      <div className="flex gap-3">
        <button type="button" className="btn-secondary" onClick={() => router.back()}>
          Отмена
        </button>
        <button className="btn-primary" disabled={submitting || uploading}>
          {submitting ? 'Сохранение…' : mode === 'create' ? 'Опубликовать' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}
