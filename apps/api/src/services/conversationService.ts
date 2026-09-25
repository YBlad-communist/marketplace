import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { deleteObject, verifyImageObject } from '../lib/s3.js';
import { processImage } from './imageService.js';

/**
 * Web-клиент не знает S3-адрес, поэтому к ключам фото прикладываем готовые URL.
 */
function withImageUrls<T extends { imageKey: string | null; imageThumbKey: string | null }>(m: T) {
  return {
    ...m,
    imageUrl: m.imageKey ? `${env.S3_PUBLIC_BASE_URL}/${m.imageKey}` : null,
    imageThumbUrl: m.imageThumbKey ? `${env.S3_PUBLIC_BASE_URL}/${m.imageThumbKey}` : null,
  };
}

function presentMessage<T extends { deletedAt: Date | null; text: string; imageKey: string | null; imageThumbKey: string | null }>(m: T) {
  return m.deletedAt ? withImageUrls({ ...m, text: 'Сообщение удалено' }) : withImageUrls(m);
}

const MSG_RATE_WINDOW = 10_000;
const MSG_RATE_MAX = 10;

export async function createConversation(input: { listingId?: string; recipientId?: string; userId: string }) {
  // Личный чат без объявления (например, с профиля пользователя).
  if (!input.listingId) {
    if (!input.recipientId) {
      throw new AppError(errorCodes.VALIDATION, 'Укажите объявление или получателя', 400);
    }
    if (input.recipientId === input.userId) {
      throw new AppError(errorCodes.VALIDATION, 'Нельзя написать самому себе', 400);
    }
    const recipient = await prisma.user.findUnique({
      where: { id: input.recipientId },
      select: { id: true },
    });
    if (!recipient) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
    const existing = await prisma.conversation.findFirst({
      where: {
        listingId: null,
        participants: { some: { userId: input.userId } },
        AND: [{ participants: { some: { userId: input.recipientId } } }],
      },
    });
    if (existing) return existing;
    return prisma.conversation.create({
      data: {
        listingId: null,
        participants: {
          create: [{ userId: input.userId }, { userId: input.recipientId }],
        },
      },
      include: { participants: { include: { user: { select: { id: true, name: true } } } } },
    });
  }

  const listing = await prisma.listing.findUnique({ where: { id: input.listingId } });
  if (!listing) throw new AppError(errorCodes.NOT_FOUND, 'Объявление не найдено', 404);
  if (listing.sellerId === input.userId) {
    throw new AppError(errorCodes.VALIDATION, 'Нельзя написать самому себе', 400);
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      listingId: listing.id,
      participants: { some: { userId: input.userId } },
    },
  });
  if (existing) return existing;

  const conversation = await prisma.conversation.create({
    data: {
      listingId: listing.id,
      participants: {
        create: [{ userId: input.userId }, { userId: listing.sellerId }],
      },
    },
    include: { participants: { include: { user: { select: { id: true, name: true } } } } },
  });
  return conversation;
}

export async function assertParticipant(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: true },
  });
  if (!conversation) {
    throw new AppError(errorCodes.NOT_FOUND, 'Чат не найден', 404);
  }
  const isParticipant = conversation.participants.some((p) => p.userId === userId);
  if (!isParticipant) {
    throw new AppError(errorCodes.FORBIDDEN, 'Нет доступа к чату', 403);
  }
  return conversation;
}

export async function listConversations(userId: string, cursor?: string, limit = 20) {
  const take = Math.min(limit, 50) + 1;
  const conversations = await prisma.conversation.findMany({
    where: { participants: { some: { userId } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    include: {
      listing: { select: { id: true, title: true, price: true, images: { take: 1, orderBy: { position: 'asc' as const } } } },
      participants: {
        include: { user: { select: { id: true, name: true, avatarUrl: true } } },
      },
      messages: { orderBy: { createdAt: 'desc' as const }, take: 1 },
    },
  });

  const hasMore = conversations.length > limit;
  const page = conversations.slice(0, limit);
  const ids = page.map((c) => c.id);
  const unread = await prisma.conversationParticipant.findMany({
    where: { userId, conversationId: { in: ids } },
    select: { conversationId: true, lastReadAt: true },
  });
  const lastRead = new Map(unread.map((u) => [u.conversationId, u.lastReadAt?.getTime() ?? 0]));

  // Один сгруппированный запрос на все диалоги страницы вместо N отдельных
  // COUNT — раньше список с M непрочитанными чатами делал 1 + M запросов.
  const lastReadMap = new Map(
    page.map((c) => {
      const lastMessage = c.messages[0] ? presentMessage(c.messages[0]) : null;
      const lastReadAt = lastRead.get(c.id) ?? 0;
      const needsCount =
        !!lastMessage && new Date(lastMessage.createdAt).getTime() > lastReadAt;
      return [c.id, needsCount ? lastReadAt : -1] as const;
    })
  );
  const unreadMap = await unreadCountsByConversation(
    page.map((c) => c.id),
    lastReadMap
  );

  const items = page.map((c) => {
    const lastMessage = c.messages[0] ? presentMessage(c.messages[0]) : null;
    return {
      id: c.id,
      listing: c.listing,
      participants: c.participants.map((p) => p.user),
      lastMessage,
      unreadCount: unreadMap.get(c.id) ?? 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });
  const nextCursor = hasMore ? page[page.length - 1].id : null;
  return { items, nextCursor, total: await prisma.conversation.count({ where: { participants: { some: { userId } } } }) };
}

async function unreadCountsByConversation(
  conversationIds: string[],
  lastReadMap: Map<string, number>
): Promise<Map<string, number>> {
  const wanted = conversationIds.filter((id) => (lastReadMap.get(id) ?? -1) >= 0);
  if (wanted.length === 0) return new Map();
  const rows = await prisma.message.groupBy({
    by: ['conversationId'],
    where: {
      conversationId: { in: wanted },
      OR: wanted.map((id) => ({
        conversationId: id,
        createdAt: { gt: new Date(lastReadMap.get(id) ?? 0) },
      })),
    },
    _count: true,
  });
  return new Map(rows.map((r) => [r.conversationId, r._count]));
}

export async function getMessages(conversationId: string, userId: string, cursor?: string, limit = 50) {
  await assertParticipant(conversationId, userId);
  const take = Math.min(limit, 100) + 1;
  const messages = await prisma.message.findMany({
    where: { conversationId, ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { id: 'desc' },
    take,
  });
  const hasMore = messages.length > take - 1;
  const page = messages
    .slice(0, take - 1)
    .reverse()
    .map((m) => presentMessage(m));
  return {
    items: page,
    nextCursor: hasMore && page.length > 0 ? page[0].id : null,
  };
}

export async function deleteMessage(conversationId: string, messageId: string, msgUserId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.conversationId !== conversationId) {
    throw new AppError(errorCodes.NOT_FOUND, 'Сообщение не удалено', 404);
  }
  if (message.senderId !== msgUserId) {
    throw new AppError(errorCodes.FORBIDDEN, 'Удалять можно только свои сообщения', 403);
  }
  return prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
  });
}

export async function editMessage(conversationId: string, messageId: string, msgUserId: string, text: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.conversationId !== conversationId) {
    throw new AppError(errorCodes.NOT_FOUND, 'Сообщение не найдено', 404);
  }
  if (message.senderId !== msgUserId) {
    throw new AppError(errorCodes.FORBIDDEN, 'Редактировать можно только свои сообщения', 403);
  }
  if (message.deletedAt) {
    throw new AppError(errorCodes.CONFLICT, 'Удалённое сообщение нельзя редактировать', 409);
  }
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { text, editedAt: new Date() },
  });
  return withImageUrls(updated);
}

/**
 * Удаление чата ДЛЯ ОБОИХ участников (hard delete): каскадом уходят
 * сообщения и участники. Возвращает id участников (для сокет-эмитта)
 * и S3-ключи фото (для фонового удаления из хранилища).
 */
export async function deleteConversation(conversationId: string, userId: string) {
  const conversation = await assertParticipant(conversationId, userId);
  const messages = await prisma.message.findMany({
    where: { conversationId },
    select: { imageKey: true, imageThumbKey: true },
  });
  const imageKeys = messages.flatMap((m) => [m.imageKey, m.imageThumbKey].filter((k): k is string => !!k));
  const participantIds = conversation.participants.map((p) => p.userId);
  await prisma.conversation.delete({ where: { id: conversationId } });
  return { participantIds, imageKeys };
}

export async function markRead(conversationId: string, userId: string): Promise<void> {
  await assertParticipant(conversationId, userId);
  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: new Date() },
  });
}

export async function checkMessageRate(userId: string): Promise<void> {
  const redis = getRedis();
  const key = `chat:rate:${userId}:${Math.floor(Date.now() / MSG_RATE_WINDOW)}`;
  const count = await redis.incr(key);
  await redis.expire(key, Math.ceil(MSG_RATE_WINDOW / 1000));
  if (count > MSG_RATE_MAX) {
    throw new AppError(errorCodes.RATE_LIMITED, 'Слишком много сообщений', 429);
  }
}

export async function createMessage(input: { conversationId: string; userId: string; text: string; imageKey?: string }) {
  await assertParticipant(input.conversationId, input.userId);
  await checkMessageRate(input.userId);
  // Фото в чате: ключ обязан быть из чат-presign-сета (scope=chat), иначе
  // чужой ключ из сета листингов позволил бы прикрепить чужое фото.
  let imageKey: string | null = null;
  let imageThumbKey: string | null = null;
  if (input.imageKey) {
    const redis = getRedis();
    const setKey = `presign:chat:user:${input.userId}`;
    const isIssued = await redis.sismember(setKey, input.imageKey);
    if (!isIssued) {
      throw new AppError(errorCodes.VALIDATION, 'Файл не был загружен через presigned URL', 400);
    }
    await redis.srem(setKey, input.imageKey);
    await verifyImageObject(input.imageKey);
    const processed = await processImage(input.imageKey);
    await deleteObject(input.imageKey);
    imageKey = processed.fullKey;
    imageThumbKey = processed.thumbKey;
  }
  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.userId,
        text: input.text,
        imageKey,
        imageThumbKey,
      },
      include: { sender: { select: { id: true, name: true } } },
    }),
    prisma.conversation.update({
      where: { id: input.conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);
  return withImageUrls(message);
}
