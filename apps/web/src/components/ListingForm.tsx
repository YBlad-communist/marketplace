'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, get, post, patch } from '@/lib/api';
import { ImageUploader } from '@/components/ImageUploader';
import { ExistingImagesEditor } from '@/components/ExistingImagesEditor';
import { CategoryAttributeDto, CategoryDto, ListingDto, RegionDto } from '@/lib/types';

/** Путь от корня до категории по id: [раздел, подраздел, третий уровень]. */
function findCategoryPath(roots: CategoryDto[], targetId: string, path: string[] = []): string[] {
  for (const node of roots) {
    const next = [...path, node.id];
    if (node.id === targetId) return next;
    const childPath = findCategoryPath(node.children ?? [], targetId, next);
    if (childPath.length > 0) return childPath;
  }
  return [];
}

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
  // useMemo: ссылка на массив не должна меняться каждый рендер — иначе
  // useEffect раскладки пути при редактировании будет перезапускаться.
  const roots = useMemo(() => categoriesQuery.data?.data.categories ?? [], [categoriesQuery.data]);

  // Локация: регион → город. Если справочник пуст (старый инстанс) —
  // остаётся текстовое поле city, форма работает как раньше.
  const regionsQuery = useQuery({
    queryKey: ['regions'],
    queryFn: () => get<{ data: { regions: RegionDto[] } }>('/api/regions'),
  });
  const regions = regionsQuery.data?.data.regions ?? [];
  const hasLocations = regions.length > 0;

  // Каскад категорий: раздел → подраздел → третий уровень (любая глубина).
  const [parentId, setParentId] = useState('');
  const [childId, setChildId] = useState('');
  const [grandId, setGrandId] = useState('');
  const [regionId, setRegionId] = useState(initial?.cityRef?.region?.id ?? '');
  const [cityId, setCityId] = useState(initial?.cityRef?.id ?? initial?.cityId ?? '');
  const [pathReady, setPathReady] = useState(false);

  // Редактирование: раскладываем categoryId по пути в дереве после загрузки.
  useEffect(() => {
    if (pathReady || roots.length === 0) return;
    if (mode === 'edit' && initial?.category) {
      const path = findCategoryPath(roots, initial.category.id);
      setParentId(path[0] ?? initial.category.parent?.id ?? initial.category.id);
      setChildId(path[1] ?? '');
      setGrandId(path[2] ?? '');
    }
    setPathReady(true);
  }, [roots, initial, mode, pathReady]);

  const selectedParent = roots.find((c) => c.id === parentId);
  const selectedChild = selectedParent?.children?.find((ch) => ch.id === childId);
  const selectedGrand = selectedChild?.children?.find((g) => g.id === grandId);
  // Итоговая категория — самый глубокий выбранный уровень (корень допустим).
  const categoryId = grandId || childId || parentId;
  // Наследование атрибутов: раздел → подраздел → третий уровень (глубже побеждает).
  const byKey = new Map<string, CategoryAttributeDto>();
  for (const a of [
    ...(selectedParent?.attributes ?? []),
    ...(selectedChild?.attributes ?? []),
    ...(selectedGrand?.attributes ?? []),
  ]) {
    byKey.set(a.key, a);
  }
  const attributes = [...byKey.values()];

  const selectedRegion = regions.find((r) => r.id === regionId);
  const cities = selectedRegion?.cities ?? [];
  const selectedCity = cities.find((c) => c.id === cityId);

  const hasTypedAttributes = () => Object.values(attributeValues).some((v) => v !== '');

  const changeParent = (next: string) => {
    if (next !== parentId && hasTypedAttributes()) {
      if (!confirm('При смене раздела введённые характеристики будут сброшены. Продолжить?')) return;
    }
    setParentId(next);
    setChildId('');
    setGrandId('');
    // Сбрасываем атрибуты при смене категории, иначе отправятся чужие ключи.
    setAttributeValues({});
  };

  const changeChild = (next: string) => {
    if (next !== childId && hasTypedAttributes()) {
      if (!confirm('При смене подраздела введённые характеристики будут сброшены. Продолжить?')) return;
    }
    setChildId(next);
    setGrandId('');
    setAttributeValues({});
  };

  const changeGrand = (next: string) => {
    if (next !== grandId && hasTypedAttributes()) {
      if (!confirm('При смене категории введённые характеристики будут сброшены. Продолжить?')) return;
    }
    setGrandId(next);
    setAttributeValues({});
  };

  const changeRegion = (next: string) => {
    setRegionId(next);
    setCityId('');
  };

  const changeCity = (next: string) => {
    setCityId(next);
    // Город продублируем в текстовое поле city — обязательное поле формы.
    const c = cities.find((x) => x.id === next);
    if (c) setCity(c.name);
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

    // При включённом справочнике локаций город выбирается из списка (cityId);
    // текстовое city подставляется его именем, чтобы валидация не падала.
    if (hasLocations && !cityId) {
      setErrors({ cityId: 'Выберите регион и город' });
      setGeneral('Выберите регион и город');
      setSubmitting(false);
      return;
    }
    const finalCity = hasLocations && selectedCity ? selectedCity.name : city;

    const body = {
      title,
      description,
      price: Number(price),
      currency: 'RUB',
      categoryId,
      city: finalCity,
      ...(cityId ? { cityId } : {}),
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
        {hasLocations ? (
          <div>
            <label className="label">Регион *</label>
            <select className="input" value={regionId} onChange={(e) => changeRegion(e.target.value)} required>
              <option value="">Выберите регион</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="label">Город *</label>
            <input className="input" value={city} onChange={(e) => setCity(e.target.value)} required />
            {errors.city && <p className="mt-1 text-xs text-danger">{errors.city}</p>}
          </div>
        )}
      </div>

      {hasLocations && (
        <div>
          <label className="label">Город *</label>
          <select
            className="input"
            value={cityId}
            onChange={(e) => changeCity(e.target.value)}
            disabled={!selectedRegion || cities.length === 0}
            required
          >
            <option value="">
              {selectedRegion ? 'Выберите город' : 'Сначала выберите регион'}
            </option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {errors.cityId && <p className="mt-1 text-xs text-danger">{errors.cityId}</p>}
        </div>
      )}

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
            onChange={(e) => changeChild(e.target.value)}
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
      {selectedChild && (selectedChild.children ?? []).length > 0 && (
        <div>
          <label className="label">Категория</label>
          <select className="input" value={grandId} onChange={(e) => changeGrand(e.target.value)}>
            <option value="">Вся подкатегория «{selectedChild.name}»</option>
            {(selectedChild.children ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}
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
