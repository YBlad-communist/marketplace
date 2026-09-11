import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { getRedis } from '../lib/redis.js';

const MSG_RATE_WINDOW = 10_000;
const MSG_RATE_MAX = 10;

export async function createConversation(input: { listingId: string; userId: string }) {
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

  const items = await Promise.all(
    page.map(async (c) => {
      const lastMessage = c.messages[0] ?? null;
      const lastReadAt = lastRead.get(c.id) ?? 0;
      const unreadCount =
        lastMessage && new Date(lastMessage.createdAt).getTime() > lastReadAt
          ? await awaitUnreadCount(c.id, lastReadAt)
          : 0;
      return {
        id: c.id,
        listing: c.listing,
        participants: c.participants.map((p) => p.user),
        lastMessage,
        unreadCount,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    })
  );
  const nextCursor = hasMore ? page[page.length - 1].id : null;
  return { items, nextCursor, total: await prisma.conversation.count({ where: { participants: { some: { userId } } } }) };
}

async function awaitUnreadCount(conversationId: string, lastReadAt: number): Promise<number> {
  return prisma.message.count({
    where: { conversationId, createdAt: { gt: new Date(lastReadAt) } },
  });
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
  const page = messages.slice(0, take - 1).reverse();
  return {
    items: page,
    nextCursor: hasMore && page.length > 0 ? page[0].id : null,
  };
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

export async function createMessage(input: { conversationId: string; userId: string; text: string }) {
  await assertParticipant(input.conversationId, input.userId);
  await checkMessageRate(input.userId);
  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.userId,
        text: input.text,
      },
      include: { sender: { select: { id: true, name: true } } },
    }),
    prisma.conversation.update({
      where: { id: input.conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);
  return message;
}
