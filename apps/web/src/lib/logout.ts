import { useRouter } from 'next/navigation';
import { post, setAccessToken } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { useAuthStore } from '@/lib/auth-store';

/** Единый выход: сброс refresh-cookie, токена, сокета и стора + редирект на главную. */
export function useLogout() {
  const router = useRouter();
  return async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setAccessToken(null);
    disconnectSocket();
    useAuthStore.getState().setUser(null);
    router.push('/');
    router.refresh();
  };
}
