'use client';

import { useEffect, useRef } from 'react';
import { MicIcon, PaperclipIcon, SendIcon, SmileIcon } from './icons';
import { useToast } from '@/components/ui/Toast';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onAttach: () => void;
  onTyping: () => void;
  uploading: boolean;
}

export function Composer({ value, onChange, onSend, onAttach, onTyping, uploading }: Props) {
  const { toast } = useToast();
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize до 5 строк.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 22;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !uploading;

  return (
    <div
      className="shrink-0 border-t border-border bg-surface px-3 py-2"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      <div className="flex items-end gap-1">
        <button
          type="button"
          onClick={onAttach}
          disabled={uploading}
          aria-label="Прикрепить фото"
          title="Прикрепить фото"
          className="rounded-full p-2 text-textSecondary transition-colors hover:bg-surfaceMuted hover:text-textPrimary"
        >
          <PaperclipIcon />
        </button>
        <label htmlFor="chat-composer" className="sr-only">
          Сообщение
        </label>
        <textarea
          ref={areaRef}
          id="chat-composer"
          rows={1}
          className="max-h-[110px] min-h-[40px] flex-1 resize-none rounded-2xl bg-surfaceMuted px-3 py-2 text-sm leading-relaxed text-textPrimary outline-none placeholder:text-textMuted focus:ring-2 focus:ring-focus"
          placeholder="Сообщение… (Enter — отправить, Shift+Enter — новая строка)"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onTyping();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          type="button"
          aria-label="Эмодзи"
          title="Эмодзи"
          onClick={() => toast('Эмодзи-панель скоро появится', 'info')}
          className="hidden rounded-full p-2 text-textSecondary transition-colors hover:bg-surfaceMuted hover:text-textPrimary sm:block"
        >
          <SmileIcon />
        </button>
        {canSend ? (
          <button
            type="button"
            onClick={onSend}
            aria-label="Отправить сообщение"
            title="Отправить"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-transform hover:bg-accentHover active:scale-95"
          >
            <SendIcon />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Голосовое сообщение"
            title="Голосовое сообщение"
            onClick={() => toast('Голосовые сообщения скоро появятся', 'info')}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-textSecondary transition-colors hover:bg-surfaceMuted hover:text-textPrimary"
          >
            <MicIcon />
          </button>
        )}
      </div>
    </div>
  );
}
