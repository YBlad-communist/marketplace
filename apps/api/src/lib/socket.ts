import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { prisma } from '@marketplace/db';
import { AppError, MAINTENANCE_JOBS, QUEUES } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from './redis.js';
import { getQueue } from '../queues/index.js';
import { isAccessTokenBlacklisted } from '../services/tokenService.js';
import {
  assertParticipant,
  createMessage,
  markRead,
  deleteMessage,
} from '../services/conversationService.js';

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
    // Счётчик подключений: несколько вкладок/устройств — один и тот же онлайн.
    // Снимаем с ws:online только на ПОСЛЕДНЕМ закрытии (декремент до нуля).
    await markConnected(userId);
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
          const online = await isOnline(otherId);
          if (!online) {
            await scheduleOfflineDigest(otherId, payload.conversationId);
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

    socket.on('message:delete', async (payload: { conversationId: string; messageId: string }, cb) => {
      try {
        await deleteMessage(payload.conversationId, payload.messageId, userId);
        socket.to(`room:${payload.conversationId}`).emit('message:deleted', {
          conversationId: payload.conversationId,
          messageId: payload.messageId,
        });
        cb?.({ ok: true });
      } catch (err) {
        const e = err as AppError;
        cb?.({ ok: false, error: e.message ?? 'Не удалось удалить сообщение' });
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
      await markDisconnected(userId);
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

const presenceKey = (userId: string) => `ws:presence:${userId}`;
// TTL предохранитель: если процесс упал без disconnect, счётчик не «протекает»
// навсегда, а доживает до TTL и сам сходит на нет.
const PRESENCE_TTL_SECONDS = 43_200;

/** Новая вкладка/устройство пользователя подключились. */
async function markConnected(userId: string): Promise<void> {
  const redis = getRedis();
  const count = await redis.incr(presenceKey(userId));
  await redis.expire(presenceKey(userId), PRESENCE_TTL_SECONDS);
  await redis.set(`ws:user:${userId}`, String(count), 'EX', 3600);
  await redis.sadd('ws:online', userId);
}

/** Вкладка/устройство закрылись. Онлайн снимается только на последнем. */
async function markDisconnected(userId: string): Promise<void> {
  const redis = getRedis();
  const count = await redis.decr(presenceKey(userId));
  if (count <= 0) {
    await redis.srem('ws:online', userId);
    await redis.del(presenceKey(userId));
  }
}

/** Пользователь онлайн? Считаем по наличию счётчика, а не по ws:online. */
async function isOnline(userId: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.exists(presenceKey(userId))) === 1;
}

const digestCountKey = (userId: string, conversationId: string) => `offline:msgcount:${userId}:${conversationId}`;
const digestGateKey = (userId: string, conversationId: string) => `offline:gate:${userId}:${conversationId}`;

/**
 * Офлайн-дайджест: не письмо на каждое сообщение, а одно письмо на
 * (получатель, диалог) за окно OFFLINE_EMAIL_COOLDOWN_MS с агрегированным N.
 *
 * Gate-ключ с TTL = окно гарантирует «максимум 1 письмо за окно», счётчик
 * накапливает сообщения, а отложенная BullMQ-джоба (jobId с дедупликацией)
 * забирает счётчик через GETDEL и шлёт «у вас N новых сообщений».
 */
async function scheduleOfflineDigest(userId: string, conversationId: string): Promise<void> {
  const redis = getRedis();
  await redis.incr(digestCountKey(userId, conversationId));
  const gate = await redis.set(
    digestGateKey(userId, conversationId),
    '1',
    'EX',
    Math.max(1, Math.ceil(env.OFFLINE_EMAIL_COOLDOWN_MS / 1000)),
    'NX'
  );
  if (gate !== 'OK') return; // в этом окне джоба уже запланирована

  await getQueue(QUEUES.MAINTENANCE).add(
    MAINTENANCE_JOBS.SEND_OFFLINE_DIGEST,
    { receiverId: userId, conversationId },
    {
      jobId: `offline-digest-${userId}-${conversationId}`,
      delay: env.OFFLINE_EMAIL_COOLDOWN_MS,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
    }
  );
}
