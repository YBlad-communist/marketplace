'use client';

import { io, Socket } from 'socket.io-client';
import { getAccessToken, refreshAccessToken } from './api';
import { API_URL } from './api';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      path: '/socket.io',
      // DECISION: polling первым с апгрейдом до websocket — переживает прокси/сети,
      // режущие чистый WS (мобильные операторы, корпоративные Wi-Fi).
      transports: ['polling', 'websocket'],
      autoConnect: false,
    });
    // DECISION: access-токен живёт 15 минут. Раньше при его истечении сокет умирал
    // с unauthorized до перезагрузки страницы — теперь обновляем токен и жмём reconnect.
    socket.on('connect_error', async (err: Error) => {
      if (err?.message !== 'unauthorized') return;
      try {
        const token = await refreshAccessToken();
        if (token && socket) {
          (socket.auth as unknown as { token: string | null }) = { token };
          socket.connect();
        }
      } catch {
        // refresh не удался (нет сессии) — остаёмся офлайн до следующего логина
      }
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  // Токен мог обновиться через REST (apiFetch делает refresh на 401) — подсовываем свежий при каждом коннекте.
  (s.auth as unknown as { token: string | null }) = { token: getAccessToken() };
  if (!s.connected) {
    s.connect();
  }
  return s;
}

export function disconnectSocket(): void {
  socket?.disconnect();
}
