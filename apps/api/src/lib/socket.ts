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
  editMessage,
  deleteConversation,
} from '../services/conversationService.js';
import { enqueueS3Delete } from '../services/notificationService.js';

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
      // П.28: запоминаем exp токена — сокет отключается по истечении access-токена.
      if (typeof payload.exp === 'number') socket.data.tokenExpMs = payload.exp * 1000;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId as string;
    // П.28: по истечении access-токена принудительно отключаем сокет —
    // событийные обработчики не должны жить дольше токена.
    const tokenExpMs = socket.data.tokenExpMs as number | undefined;
    if (tokenExpMs) {
      const expTimer = setTimeout(() => {
        socket.disconnect(true);
      }, Math.max(0, tokenExpMs - Date.now()) + 100);
      socket.on('disconnect', () => clearTimeout(expTimer));
    }
    // Счётчик подключений: несколько вкладок/устройств — один и тот же онлайн.
    // Снимаем с ws:online только на ПОСЛЕДНЕМ закрытии (декремент до нуля).
    await markConnected(userId);
    // Персональная комната для уведомлений (message:new вне room:*).
    await socket.join(`user:${userId}`);

    socket.on('conversation:join', async (conversationId: string, cb?: (ok: boolean) => void) => {
      try {
        if (!(await socketRateOk(userId, 'conversation:join'))) return cb?.(false);
        await assertParticipant(conversationId, userId);
        await socket.join(`room:${conversationId}`);
        cb?.(true);
      } catch {
        cb?.(false);
      }
    });

    socket.on('message:send', async (payload: { conversationId: string; text?: string; imageKey?: string }, cb) => {
      try {
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        const imageKey = typeof payload?.imageKey === 'string' && payload.imageKey.length > 0 ? payload.imageKey : undefined;
        if (!payload?.conversationId || (imageKey && imageKey.length > 500) || text.length > 2000 || (text.length === 0 && !imageKey)) {
          cb?.({ ok: false, error: 'Некорректное сообщение' });
          return;
        }
        const message = await createMessage({
          conversationId: payload.conversationId,
          userId,
          text,
          imageKey,
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
        if (!(await socketRateOk(userId, 'typing'))) return;
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

    socket.on('message:edit', async (payload: { conversationId: string; messageId: string; text: string }, cb) => {
      try {
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        if (!payload?.conversationId || !payload?.messageId || text.length === 0 || text.length > 2000) {
          cb?.({ ok: false, error: 'Некорректное сообщение' });
          return;
        }
        const message = await editMessage(payload.conversationId, payload.messageId, userId, text);
        socket.to(`room:${payload.conversationId}`).emit('message:edited', message);
        cb?.({ ok: true, message });
      } catch (err) {
        const e = err as AppError;
        cb?.({ ok: false, error: e.message ?? 'Не удалось отредактировать сообщение' });
      }
    });

    socket.on('conversation:delete', async (conversationId: string, cb) => {
      try {
        if (typeof conversationId !== 'string' || conversationId.length === 0) {
          cb?.({ ok: false, error: 'Некорректный чат' });
          return;
        }
        const { participantIds, imageKeys, hardDeleted } = await deleteConversation(conversationId, userId);
        // П.30: эмитим «чат удалён» остальным только при hard delete
        // (оба скрыли); при мягком скрытии второй участник чат ещё видит.
        if (hardDeleted) {
          socket.to(`room:${conversationId}`).emit('conversation:deleted', { conversationId });
          for (const otherId of participantIds.filter((p) => p !== userId)) {
            socket.to(`user:${otherId}`).emit('conversation:deleted', { conversationId });
          }
          if (imageKeys.length > 0) {
            await enqueueS3Delete(imageKeys).catch(() => undefined);
          }
        }
        cb?.({ ok: true, hardDeleted });
      } catch (err) {
        const e = err as AppError;
        cb?.({ ok: false, error: e.message ?? 'Не удалось удалить чат' });
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
        if (!(await socketRateOk(userId, 'message:read'))) return cb?.(false);
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

/**
 * П.28: принудительный disconnect всех сокетов пользователя
 * (смена/сброс пароля, бан) — access-токены живых вкладок больше не годятся.
 */
export async function disconnectUserSockets(userId: string): Promise<void> {
  if (!io) return;
  try {
    await io.in(`user:${userId}`).disconnectSockets();
  } catch {
    // сокет-сервер мог быть не инициализирован (юнит-тесты)
  }
}

const WS_RATE_WINDOW_MS = 10_000;
const WS_RATE_MAX = 30;

/**
 * П.28: Redis-rate-limit на socket-события (typing, conversation:join,
 * message:read): 30 событий в 10 секунд на пользователя.
 */
async function socketRateOk(userId: string, action: string): Promise<boolean> {
  const redis = getRedis();
  const key = `ws:rl:${action}:${userId}:${Math.floor(Date.now() / WS_RATE_WINDOW_MS)}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, Math.ceil(WS_RATE_WINDOW_MS / 1000) + 1).catch(() => undefined);
  }
  return count <= WS_RATE_MAX;
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
