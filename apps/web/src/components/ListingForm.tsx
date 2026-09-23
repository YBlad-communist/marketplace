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
    case 'RANGE': {
      // Диапазонный атрибут — ползунок с видимым значением (мин/макс из категории).
      const min = attr.min ?? 0;
      const max = attr.max ?? 100;
      return (
        <div className="flex items-center gap-3">
          <input
            className="flex-1 accent-accent"
            type="range"
            min={min}
            max={max}
            value={value === '' ? String(min) : value}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="w-20 shrink-0 text-sm text-textPrimary">
            {value === '' ? min : value}
            {attr.unit ? ` ${attr.unit}` : ''}
          </span>
        </div>
      );
    }
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
  const roots = categoriesQuery.data?.data.categories ?? [];

  // Каскад: раздел → подраздел. При редактировании раскладываем categoryId:
  // дочерняя → parentId+childId, корневая → только parentId («вся категория»).
  const [parentId, setParentId] = useState(() => initial?.category?.parent?.id ?? initial?.category?.id ?? '');
  const [childId, setChildId] = useState(() =>
    initial?.category?.parent?.id ? initial.category.id : ''
  );
  const selectedParent = roots.find((c) => c.id === parentId);
  const selectedChild = selectedParent?.children?.find((ch) => ch.id === childId);
  // Итоговая категория: подраздел, либо весь раздел (тесты и бэкенд допускают корневую).
  const categoryId = childId || parentId;
  // Наследование атрибутов: атрибуты раздела + атрибуты подраздела (подраздел побеждает при совпадении ключей).
  const childAttrs = selectedChild?.attributes ?? [];
  const attributes: CategoryAttributeDto[] = [
    ...(selectedParent?.attributes ?? []).filter((a) => !childAttrs.some((x) => x.key === a.key)),
    ...childAttrs,
  ];

  const changeParent = (next: string) => {
    if (next !== parentId && Object.values(attributeValues).some((v) => v !== '')) {
      if (!confirm('При смене раздела введённые характеристики будут сброшены. Продолжить?')) return;
    }
    setParentId(next);
    setChildId('');
    // Сбрасываем атрибуты при смене категории, иначе отправятся чужие ключи.
    setAttributeValues({});
  };

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
        {errors.title && <p className="mt-1 text-xs text-danger">{errors.title}</p>}
      </div>

      <div>
        <label className="label">Описание *</label>
        <textarea
          className="input min-h-32"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        {errors.description && <p className="mt-1 text-xs text-danger">{errors.description}</p>}
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
          {errors.price && <p className="mt-1 text-xs text-danger">{errors.price}</p>}
        </div>
        <div>
          <label className="label">Город *</label>
          <input className="input" value={city} onChange={(e) => setCity(e.target.value)} required />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="label">Раздел *</label>
          <select className="input" value={parentId} onChange={(e) => changeParent(e.target.value)} required>
            <option value="">Выберите раздел</option>
            {roots.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Подраздел</label>
          <select
            className="input"
            value={childId}
            onChange={(e) => {
              setChildId(e.target.value);
              // Сбрасываем атрибуты при смене категории, иначе отправятся чужие ключи.
              setAttributeValues({});
            }}
            disabled={!selectedParent || (selectedParent.children ?? []).length === 0}
          >
            <option value="">Вся категория «{selectedParent?.name ?? '…'}»</option>
            {(selectedParent?.children ?? []).map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {errors.categoryId && <p className="mt-1 text-xs text-danger">{errors.categoryId}</p>}

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
          {errors.imageKeys && <p className="mt-1 text-xs text-danger">{errors.imageKeys}</p>}
        </div>
      ) : (
        <div>
          <label className="label">Фотографии</label>
          <ExistingImagesEditor listingId={initial!.id} />
        </div>
      )}

      {general && <p className="text-sm text-danger">{general}</p>}

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
