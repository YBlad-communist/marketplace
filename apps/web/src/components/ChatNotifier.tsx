'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/Toast';
import { connectSocket } from '@/lib/socket';
import { useAuthStore } from '@/lib/auth-store';
import { MessageDto } from '@/lib/types';

/** Короткий системный «пинг» без аудиофайлов (WebAudio). */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => void ctx.close().catch(() => undefined);
  } catch {
    // без звука — не критично
  }
}

function previewOf(msg: MessageDto): string {
  if (msg.text) return msg.text.length > 80 ? `${msg.text.slice(0, 80)}…` : msg.text;
  if (msg.imageUrl ?? msg.imageKey) return '📷 Фото';
  return 'Новое сообщение';
}

/**
 * Глобальный слушатель новых сообщений (монтируется в layout).
 * Логика API/сокетов не меняется — только UI-реакция на событие message:new:
 * свежие счётчики, тост, звук, вибрация и системное уведомление, если чат не открыт.
 */
export function ChatNotifier() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const userId = useAuthStore((s) => s.user?.id);
  const pathRef = useRef(pathname);

  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!userId) return;
    // Просим разрешение на системные уведомления один раз после входа.
    try {
      if ('Notification' in window && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const socket = connectSocket();
    const onNew = (msg: MessageDto) => {
      if (msg.senderId === userId) return;
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      // Открытый диалог сам показывает сообщение и гасит счётчик — не шумим.
      if (pathRef.current === `/chat/${msg.conversationId}`) return;

      const name = msg.sender?.name ?? 'Собеседник';
      const preview = previewOf(msg);
      toast(`Новое сообщение от ${name}: ${preview}`, 'info');
      beep();
      try {
        navigator.vibrate?.(200);
      } catch {
        // ignore
      }
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          const n = new Notification(`РынокRU · ${name}`, { body: preview, tag: msg.conversationId });
          n.onclick = () => {
            window.focus();
            window.location.href = `${window.location.origin}/chat/${msg.conversationId}`;
          };
        }
      } catch {
        // ignore
      }
    };
    socket.on('message:new', onNew);
    return () => {
      socket.off('message:new', onNew);
    };
  }, [userId, queryClient, toast]);

  return null;
}
