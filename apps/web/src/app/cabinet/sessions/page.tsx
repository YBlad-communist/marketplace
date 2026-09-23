'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { del, get, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { SessionDto } from '@/lib/types';
import { cn, formatDateTime } from '@/lib/format';

function parseDevice(userAgent: string | null): string {
  if (!userAgent) return 'Неизвестное устройство';
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(userAgent);
  const os =
    /Windows/i.test(userAgent) ? 'Windows'
    : /iPhone|iPad|Mac OS X/.test(userAgent) ? 'macOS/iOS'
    : /Android/i.test(userAgent) ? 'Android'
    : /Linux/i.test(userAgent) ? 'Linux'
    : null;
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Safari\//.test(userAgent) ? 'Safari'
    : null;
  return [os, browser, isMobile ? 'мобильный' : null].filter(Boolean).join(' · ') || userAgent.slice(0, 60);
}

export default function SessionsPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => get<{ data: { items: SessionDto[] } }>('/api/auth/sessions'),
    enabled: Boolean(user?.id),
  });

  const revoke = async (familyId: string) => {
    setError(null);
    try {
      await del(`/api/auth/sessions/${familyId}`);
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось завершить сессию');
    }
  };

  if (!user) {
    return (
      <div>
        <Header />
        <main className="container-x py-8">
          <h1 className="mb-4 text-2xl font-bold">Активные сессии</h1>
          <p className="text-textSecondary">
            Войдите, чтобы управлять сессиями.{' '}
            <Link href="/login" className="text-accent">
              Войти
            </Link>
          </p>
        </main>
      </div>
    );
  }

  const sessions = sessionsQuery.data?.data.items ?? [];

  return (
    <div>
      <Header />
      <main className="container-x py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Активные сессии</h1>
          <Link href="/cabinet" className="btn-secondary text-xs">
            ← В кабинет
          </Link>
        </div>

        <p className="mb-6 text-sm text-textSecondary">
          Здесь отображаются устройства и браузеры, вошедшие в аккаунт. Завершайте незнакомые сессии, чтобы обезопасить
          аккаунт.
        </p>

        {error && <div className="card mb-4 border-danger/20 bg-danger/5 p-3 text-sm text-danger">{error}</div>}

        <div className="space-y-3">
          {sessionsQuery.isLoading &&
            Array.from({ length: 1 }).map((_, i) => <div key={i} className="card h-20" aria-hidden />)}
          {sessions.map((s) => (
            <div key={s.familyId} className="card flex flex-wrap items-center gap-4 p-4">
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surfaceMuted text-accentHover"
                aria-hidden
              >
                ⌘
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{parseDevice(s.userAgent)}</span>
                  {s.current && <span className="badge-green">Текущая сессия</span>}
                </div>
                <div className="mt-0.5 text-sm text-textSecondary">
                  IP: {s.ip ?? '—'} · Активна с {formatDateTime(s.createdAt)} · До {formatDateTime(s.expiresAt)}
                </div>
              </div>
              {!s.current && (
                <button
                  className={cn('btn-danger text-xs')}
                  onClick={() => revoke(s.familyId)}
                  disabled={sessionsQuery.isFetching}
                >
                  Завершить
                </button>
              )}
            </div>
          ))}
          {!sessionsQuery.isLoading && sessions.length === 0 && (
            <div className="text-textSecondary">Активных сессий нет.</div>
          )}
        </div>
      </main>
    </div>
  );
}