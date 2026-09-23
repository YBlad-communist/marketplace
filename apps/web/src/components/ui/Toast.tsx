'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { cn } from '@/lib/format';

type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastContext = createContext<{ toast: (text: string, kind?: ToastKind) => void }>({
  toast: () => undefined,
});

export const useToast = () => useContext(ToastContext);

const kindStyles: Record<ToastKind, string> = {
  success: 'border-success/30 bg-surface text-textPrimary',
  error: 'border-danger/30 bg-surface text-textPrimary',
  info: 'border-info/30 bg-surface text-textPrimary',
};

const kindDot: Record<ToastKind, string> = {
  success: 'bg-success',
  error: 'bg-danger',
  info: 'bg-info',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++idRef.current;
    setItems((list) => [...list.slice(-3), { id, kind, text }]);
    setTimeout(() => {
      setItems((list) => list.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-20 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4 md:bottom-6" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn('toast-enter pointer-events-auto flex items-center gap-2 rounded-xl border bg-surface px-4 py-3 text-sm shadow-modal', kindStyles[t.kind])}
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', kindDot[t.kind])} aria-hidden />
            <span className="flex-1">{t.text}</span>
            <button
              type="button"
              aria-label="Закрыть уведомление"
              className="text-textMuted hover:text-textPrimary"
              onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
