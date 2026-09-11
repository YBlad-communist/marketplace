import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { prisma } from '@marketplace/db';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { isAccessTokenBlacklisted } from '../services/tokenService.js';
import {
  assertParticipant,
  createMessage,
  markRead,
} from '../services/conversationService.js';
import { enqueueEmail } from '../services/notificationService.js';
import { AppError } from '@marketplace/shared';

let io: Server | null = null;

export function initSocket(httpServer: http.Server): Server {
  const redis = getRedis();
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  pubClient.connect().catch((err) => console.error('socket pub redis connect failed', err));
  subClient.connect().catch((err) => console.error('socket sub redis connect failed', err));

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
        issuer: env.JWT_ISSUER,
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;
      if (payload.type !== 'access' || !payload.sub || !payload.jti) return next(new Error('unauthorized'));
      if (await isAccessTokenBlacklisted(payload.jti)) return next(new Error('unauthorized'));
      const user = await prisma.user.findUnique({ where: { id: String(payload.sub) } });
      if (!user || user.isBanned) return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId as string;
    const redis = getRedis();
    await redis.set(`ws:user:${userId}`, '1', 'EX', 3600);
    await redis.sadd('ws:online', userId);
    // Персональная комната для уведомлений (message:new вне room:*).
    await socket.join(`user:${userId}`);

    socket.on('conversation:join', async (conversationId: string, cb?: (ok: boolean) => void) => {
      try {
        await assertParticipant(conversationId, userId);
        await socket.join(`room:${conversationId}`);
        cb?.(true);
      } catch {
        cb?.(false);
      }
    });

    socket.on('message:send', async (payload: { conversationId: string; text: string }, cb) => {
      try {
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        if (!payload?.conversationId || text.length === 0 || text.length > 2000) {
          cb?.({ ok: false, error: 'Некорректное сообщение' });
          return;
        }
        const message = await createMessage({
          conversationId: payload.conversationId,
          userId,
          text,
        });
        const participants = await participantsOf(payload.conversationId);
        socket.to(`room:${payload.conversationId}`).emit('message:new', message);
        const otherIds = participants.filter((p) => p !== userId);
        for (const otherId of otherIds) {
          socket.to(`user:${otherId}`).emit('message:new', message);
          const online = await redis.sismember('ws:online', otherId);
          if (!online) {
            await enqueueOfflineNotification(otherId, payload.conversationId, payload.text);
          }
        }
        cb?.({ ok: true, message });
      } catch (err) {
        const e = err as AppError;
        cb?.({ ok: false, error: e.message ?? 'Не удалось отправить' });
      }
    });

    socket.on('typing', async (payload: { conversationId: string; isTyping: boolean }) => {
      try {
        await assertParticipant(payload.conversationId, userId);
        socket.to(`room:${payload.conversationId}`).emit('typing', {
          conversationId: payload.conversationId,
          userId,
          isTyping: payload.isTyping,
        });
      } catch {
        // ignore
      }
    });

    socket.on('message:read', async (conversationId: string, cb) => {
      try {
        await markRead(conversationId, userId);
        socket.to(`room:${conversationId}`).emit('message:read', { conversationId, userId });
        cb?.(true);
      } catch {
        cb?.(false);
      }
    });

    socket.on('disconnect', async () => {
      await redis.srem('ws:online', userId);
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('socket.io not initialized');
  return io;
}

async function participantsOf(conversationId: string): Promise<string[]> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { select: { userId: true } } },
  });
  return conv?.participants.map((p) => p.userId) ?? [];
}

async function enqueueOfflineNotification(
  userId: string,
  conversationId: string,
  preview: string
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true },
  });
  if (!user || !user.email) return;
  await enqueueEmail({
    to: user.email,
    subject: 'Новое сообщение в Marketplace',
    template: 'new-message',
    templateData: { name: user.name, preview: preview.slice(0, 120) },
    text: `У вас новое сообщение: ${preview.slice(0, 120)}`,
  });
}
