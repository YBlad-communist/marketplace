'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ApiError, del, get, patch, post } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { cn } from '@/lib/format';
import { RegionDto } from '@/lib/types';

function RegionBlock({
  region,
  onUpdate,
  onDelete,
  onCreateCity,
  onUpdateCity,
  onDeleteCity,
}: {
  region: RegionDto;
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string, name: string) => void;
  onCreateCity: (regionId: string, name: string) => void;
  onUpdateCity: (id: string, data: Record<string, unknown>) => void;
  onDeleteCity: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [regionName, setRegionName] = useState(region.name);
  const [editingRegion, setEditingRegion] = useState(false);
  const [cityName, setCityName] = useState('');
  const [editingCityId, setEditingCityId] = useState<string | null>(null);
  const [editingCityName, setEditingCityName] = useState('');

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={cn('w-6 text-textSecondary transition-transform', !open && '-rotate-90')}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Свернуть' : 'Развернуть'}
        >
          ▾
        </button>
        {editingRegion ? (
          <>
            <input
              className="input flex-1 min-w-32"
              value={regionName}
              onChange={(e) => setRegionName(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => {
                onUpdate(region.id, { name: regionName });
                setEditingRegion(false);
              }}
            >
              Сохранить
            </button>
            <button type="button" className="btn-secondary text-xs" onClick={() => setEditingRegion(false)}>
              Отмена
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate font-medium">
              {region.name}
              <span className="ml-2 text-xs text-textMuted">/{region.slug}</span>
              {region.isActive === false && (
                <span className="ml-2 rounded bg-surfaceMuted px-1.5 py-0.5 text-xs text-textSecondary">выкл</span>
              )}
            </span>
            <span className="text-xs text-textMuted">{(region.cities ?? []).length} городов</span>
            <button type="button" className="btn-secondary text-xs" onClick={() => setEditingRegion(true)}>
              Изменить
            </button>
            <button
              type="button"
              className="btn-secondary text-xs !text-danger"
              onClick={() => onDelete(region.id, region.name)}
            >
              Удалить
            </button>
          </>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-2 border-l-2 border-border pl-4">
          {(region.cities ?? []).map((city) => (
            <div key={city.id} className="flex flex-wrap items-center gap-2">
              {editingCityId === city.id ? (
                <>
                  <input
                    className="input flex-1 min-w-32"
                    autoFocus
                    value={editingCityName}
                    onChange={(e) => setEditingCityName(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    onClick={() => {
                      onUpdateCity(city.id, { name: editingCityName });
                      setEditingCityId(null);
                    }}
                  >
                    Сохранить
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => setEditingCityId(null)}
                  >
                    Отмена
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {city.name}
                    <span className="ml-2 text-xs text-textMuted">/{city.slug}</span>
                  </span>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => {
                      setEditingCityId(city.id);
                      setEditingCityName(city.name);
                    }}
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs !text-danger"
                    onClick={() => onDeleteCity(city.id, city.name)}
                  >
                    Удалить
                  </button>
                </>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <input
              className="input flex-1"
              placeholder="Новый город"
              value={cityName}
              onChange={(e) => setCityName(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={!cityName.trim()}
              onClick={() => {
                onCreateCity(region.id, cityName.trim());
                setCityName('');
              }}
            >
              Добавить город
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminLocationsPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN';

  const [regionName, setRegionName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const regionsQuery = useQuery({
    queryKey: ['admin-regions'],
    queryFn: () => get<{ data: { regions: RegionDto[] } }>('/api/regions?all=1'),
    enabled: isAdmin,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-regions'] });
  const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : 'Ошибка запроса');
  const onError = (err: unknown) => setError(errMsg(err));

  const createRegion = useMutation({
    mutationFn: (name: string) => post('/api/admin/regions', { name }),
    onSuccess: invalidate,
    onError,
  });
  const updateRegion = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      patch(`/api/admin/regions/${id}`, data),
    onSuccess: invalidate,
    onError,
  });
  const deleteRegion = useMutation({
    mutationFn: (id: string) => del(`/api/admin/regions/${id}`),
    onSuccess: invalidate,
    onError,
  });
  const createCity = useMutation({
    mutationFn: ({ regionId, name }: { regionId: string; name: string }) =>
      post('/api/admin/cities', { regionId, name }),
    onSuccess: invalidate,
    onError,
  });
  const updateCity = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      patch(`/api/admin/cities/${id}`, data),
    onSuccess: invalidate,
    onError,
  });
  const deleteCity = useMutation({
    mutationFn: (id: string) => del(`/api/admin/cities/${id}`),
    onSuccess: invalidate,
    onError,
  });

  if (!isAdmin) {
    return (
      <div>
        <Header />
        <main className="container-x py-10 text-center text-textSecondary">Нет доступа</main>
      </div>
    );
  }

  return (
    <div>
      <Header />
      <main className="container-x py-8">
        <h1 className="section-title mb-6">Локации: регионы и города</h1>

        <div className="card mb-4 flex items-center gap-2 p-4">
          <input
            className="input flex-1"
            placeholder="Название нового региона (например, «Москва»)"
            value={regionName}
            onChange={(e) => setRegionName(e.target.value)}
          />
          <button
            type="button"
            className="btn-primary text-sm"
            disabled={!regionName.trim() || createRegion.isPending}
            onClick={() => {
              setError(null);
              createRegion.mutate(regionName.trim(), { onSuccess: () => setRegionName('') });
            }}
          >
            Добавить регион
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-danger">{error}</p>}

        <div className="space-y-3">
          {(regionsQuery.data?.data.regions ?? []).map((region) => (
            <RegionBlock
              key={region.id}
              region={region}
              onUpdate={(id, data) => updateRegion.mutate({ id, data })}
              onDelete={(id, name) => {
                if (
                  !window.confirm(
                    `Удалить регион «${name}» со всеми городами? Привязка городов у объявлений сохранится в текстовом поле city.`
                  )
                )
                  return;
                setError(null);
                deleteRegion.mutate(id);
              }}
              onCreateCity={(regionId, name) => {
                setError(null);
                createCity.mutate({ regionId, name });
              }}
              onUpdateCity={(id, data) => updateCity.mutate({ id, data })}
              onDeleteCity={(id, name) => {
                if (!window.confirm(`Удалить город «${name}»?`)) return;
                setError(null);
                deleteCity.mutate(id);
              }}
            />
          ))}
          {!regionsQuery.isLoading && (regionsQuery.data?.data.regions ?? []).length === 0 && (
            <div className="text-sm text-textSecondary">Регионов пока нет</div>
          )}
        </div>
      </main>
    </div>
  );
}
