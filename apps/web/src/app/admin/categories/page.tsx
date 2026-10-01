'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { ApiError, del, get, patch, post } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { cn } from '@/lib/format';
import { CategoryDto } from '@/lib/types';

interface AdminCategory extends CategoryDto {
  isActive?: boolean;
  sortOrder?: number;
}

function CategoryRow({
  node,
  depth,
  collapsed,
  toggle,
  addingUnder,
  setAddingUnder,
  editingId,
  setEditingId,
  onCreate,
  onUpdate,
  onDelete,
  error,
}: {
  node: AdminCategory;
  depth: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  addingUnder: string | null;
  setAddingUnder: (v: string | null) => void;
  editingId: string | null;
  setEditingId: (v: string | null) => void;
  onCreate: (name: string, parentId: string) => void;
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string, name: string) => void;
  error: string | null;
}) {
  const [name, setName] = useState(node.name);
  const [slug, setSlug] = useState(node.slug);
  const [childName, setChildName] = useState('');
  const children = node.children ?? [];
  const isCollapsed = collapsed.has(node.id);
  const isEditing = editingId === node.id;

  return (
    <div>
      <div
        className="card flex flex-wrap items-center gap-2 p-3"
        style={{ marginLeft: depth * 16 }}
      >
        <button
          type="button"
          className={cn('w-6 text-textSecondary transition-transform', isCollapsed && '-rotate-90')}
          onClick={() => toggle(node.id)}
          aria-label={isCollapsed ? 'Развернуть' : 'Свернуть'}
          disabled={children.length === 0}
        >
          {children.length > 0 ? '▾' : '·'}
        </button>
        {isEditing ? (
          <>
            <input className="input flex-1 min-w-32" value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" />
            <input className="input w-40" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug" />
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => {
                onUpdate(node.id, { name, slug });
                setEditingId(null);
              }}
            >
              Сохранить
            </button>
            <button type="button" className="btn-secondary text-xs" onClick={() => setEditingId(null)}>
              Отмена
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{node.name}</span>
              <span className="ml-2 text-xs text-textMuted">/{node.slug}</span>
              {node.isActive === false && (
                <span className="ml-2 rounded bg-surfaceMuted px-1.5 py-0.5 text-xs text-textSecondary">выкл</span>
              )}
            </span>
            <button type="button" className="btn-secondary text-xs" onClick={() => setAddingUnder(node.id)}>
              + Подкатегория
            </button>
            <button type="button" className="btn-secondary text-xs" onClick={() => setEditingId(node.id)}>
              Изменить
            </button>
            <button
              type="button"
              className="btn-secondary text-xs !text-danger"
              onClick={() => onDelete(node.id, node.name)}
            >
              Удалить
            </button>
          </>
        )}
        {error && <p className="w-full text-xs text-danger">{error}</p>}
      </div>

      {addingUnder === node.id && (
        <div className="card mt-1 flex items-center gap-2 p-3" style={{ marginLeft: (depth + 1) * 16 }}>
          <input
            className="input flex-1"
            autoFocus
            placeholder="Название подкатегории"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && childName.trim()) {
                onCreate(childName.trim(), node.id);
                setChildName('');
                setAddingUnder(null);
              }
            }}
          />
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={!childName.trim()}
            onClick={() => {
              onCreate(childName.trim(), node.id);
              setChildName('');
              setAddingUnder(null);
            }}
          >
            Создать
          </button>
          <button type="button" className="btn-secondary text-xs" onClick={() => setAddingUnder(null)}>
            Отмена
          </button>
        </div>
      )}

      {!isCollapsed &&
        children.map((ch) => (
          <CategoryRow
            key={ch.id}
            node={ch as AdminCategory}
            depth={depth + 1}
            collapsed={collapsed}
            toggle={toggle}
            addingUnder={addingUnder}
            setAddingUnder={setAddingUnder}
            editingId={editingId}
            setEditingId={setEditingId}
            onCreate={onCreate}
            onUpdate={onUpdate}
            onDelete={onDelete}
            error={null}
          />
        ))}
    </div>
  );
}

export default function AdminCategoriesPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN';

  const [rootName, setRootName] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => get<{ data: { categories: AdminCategory[] } }>('/api/categories?all=1'),
    enabled: isAdmin,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-categories'] });
  const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : 'Ошибка запроса');

  const create = useMutation({
    mutationFn: (body: { name: string; parentId?: string }) => post('/api/admin/categories', body),
    onSuccess: invalidate,
    onError: (err) => setError(errMsg(err)),
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      patch(`/api/admin/categories/${id}`, data),
    onSuccess: invalidate,
    onError: (err) => setError(errMsg(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/admin/categories/${id}`),
    onSuccess: invalidate,
    onError: (err) => setError(errMsg(err)),
  });

  if (!isAdmin) {
    return (
      <div>
        <Header />
        <main className="container-x py-10 text-center text-textSecondary">Нет доступа</main>
      </div>
    );
  }

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onDelete = (id: string, name: string) => {
    if (
      !window.confirm(
        `Удалить «${name}» вместе со всеми подкатегориями? Действие необратимо (если в них нет объявлений).`
      )
    )
      return;
    setError(null);
    remove.mutate(id);
  };

  return (
    <div>
      <Header />
      <main className="container-x py-8">
        <h1 className="section-title mb-6">Категории</h1>

        <div className="card mb-4 flex items-center gap-2 p-4">
          <input
            className="input flex-1"
            placeholder="Название нового раздела"
            value={rootName}
            onChange={(e) => setRootName(e.target.value)}
          />
          <button
            type="button"
            className="btn-primary text-sm"
            disabled={!rootName.trim() || create.isPending}
            onClick={() => {
              setError(null);
              create.mutate(
                { name: rootName.trim() },
                { onSuccess: () => setRootName('') }
              );
            }}
          >
            Добавить раздел
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-danger">{error}</p>}

        <div className="space-y-2">
          {(categoriesQuery.data?.data.categories ?? []).map((node) => (
            <CategoryRow
              key={node.id}
              node={node}
              depth={0}
              collapsed={collapsed}
              toggle={toggle}
              addingUnder={addingUnder}
              setAddingUnder={setAddingUnder}
              editingId={editingId}
              setEditingId={setEditingId}
              onCreate={(name, parentId) => {
                setError(null);
                create.mutate({ name, parentId });
              }}
              onUpdate={(id, data) => {
                setError(null);
                update.mutate({ id, data });
              }}
              onDelete={onDelete}
              error={null}
            />
          ))}
          {!categoriesQuery.isLoading && (categoriesQuery.data?.data.categories ?? []).length === 0 && (
            <div className="text-sm text-textSecondary">Категорий пока нет</div>
          )}
        </div>
      </main>
    </div>
  );
}
