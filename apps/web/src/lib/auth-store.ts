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
  stripeOnboarded: boolean;
}

interface AuthState {
  user: CurrentUser | null;
  setUser: (user: CurrentUser | null) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
    }),
    { name: 'marketplace-auth' }
  )
);
