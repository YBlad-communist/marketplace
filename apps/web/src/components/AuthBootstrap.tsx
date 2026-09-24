'use client';

import { useEffect } from 'react';
import { ApiError, get } from '@/lib/api';
import { CurrentUser, useAuthStore } from '@/lib/auth-store';

/**
 * Проверка сессии один раз на загрузку приложения (живёт в layout).
 * Раньше /me дёргался из Header, а Header монтируется на каждой странице заново —
 * отсюда дёргание шапки и лишний запрос при каждой навигации.
 */
export function AuthBootstrap() {
  const setUser = useAuthStore((s) => s.setUser);
  const setChecked = useAuthStore((s) => s.setChecked);

  useEffect(() => {
    let cancelled = false;
    // Не дёргаем /me для гостей на каждой странице: пробуем тихую сессию
    // один раз (refresh cookie), иначе остаёмся гостем.
    get<{ data: { user: CurrentUser | null } }>('/api/users/me')
      .then((r) => {
        if (!cancelled) setUser(r.data.user);
      })
      .catch((err) => {
        if (cancelled) return;
        // DECISION: выкидываем из аккаунта только при честном 401 (сессия реально
        // мертва). При сетевом сбое fetch бросает TypeError, а не ApiError —
        // тогда оставляем юзера из localStorage, иначе любое пропадание сети
        // на телефоне «разлогинивало» при обновлении страницы.
        if (err instanceof ApiError) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser, setChecked]);

  return null;
}
