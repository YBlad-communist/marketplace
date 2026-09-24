import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CurrentUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  avatarUrl: string | null;
  city: string | null;
  role: 'USER' | 'MODERATOR' | 'ADMIN';
  isVerified: boolean;
  isBanned: boolean;
  rating: number;
  ratingCount: number;
  yookassaShopId: string | null;
  yookassaOnboarded: boolean;
}

interface AuthState {
  user: CurrentUser | null;
  setUser: (user: CurrentUser | null) => void;
  // Проверяли ли текущую сессию через /me (один раз на загрузку приложения,
  // а не на каждую страницу — иначе шапка дёргается при каждой навигации).
  checked: boolean;
  setChecked: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
      checked: false,
      setChecked: (checked) => set({ checked }),
    }),
    { name: 'marketplace-auth', partialize: (s) => ({ user: s.user }) as AuthState }
  )
);
