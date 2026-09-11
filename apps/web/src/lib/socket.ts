'use client';

import { io, Socket } from 'socket.io-client';
import { getAccessToken } from './api';
import { API_URL } from './api';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      path: '/socket.io',
      transports: ['websocket'],
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) {
    (s.auth as unknown as { token: string | null }) = { token: getAccessToken() };
    s.connect();
  }
  return s;
}

export function disconnectSocket(): void {
  socket?.disconnect();
}
