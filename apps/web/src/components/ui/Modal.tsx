'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/format';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  labelledBy?: string;
  wide?: boolean;
}

export function Modal({ open, onClose, title, children, labelledBy, wide = false }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="overlay-enter fixed inset-0 z-50 flex items-center justify-center bg-textPrimary/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? labelledBy}
        className={cn(
          'modal-enter max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-surface p-6 shadow-modal nice-scroll',
          wide ? 'max-w-2xl' : 'max-w-md'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="mb-4 text-lg font-bold">{title}</h2>}
        {children}
      </div>
    </div>,
    document.body
  );
}
