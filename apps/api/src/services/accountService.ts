import argon2 from 'argon2';
import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { getRedis } from '../lib/redis.js';
import { logSecurityEvent } from '../lib/logger.js';
import { env } from '../config.js';
import { enqueueS3Delete } from './notificationService.js';

/** Статусы заказов, блокирующие удаление аккаунта (те же, что блокируют удаление объявления). */
const LOCKED_ORDER_STATUSES = ['PENDING', 'PAID', 'RELEASING', 'REFUNDING', 'DISPUTED'] as const;

/**
 * Полное физическое удаление аккаунта. Порядок важен из-за Restrict-связей:
 * сначала всё, что ссылается на пользователя/его сущности, потом сами сущности.
 * Активные заказы (покупатель или продавец) блокируют удаление — 409.
 * Возвращает S3-ключи для фонового удаления (аватар, фото объявлений, фото чатов).
 */
export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
  if (!user.passwordHash) {
    throw new AppError(errorCodes.CONFLICT, 'Для аккаунта не задан пароль, обратитесь в поддержку', 409);
  }
  const ok = await argon2.verify(user.passwordHash, password);
  if (!ok) {
    logSecurityEvent('failed_account_delete', { userId });
    throw new AppError(errorCodes.UNAUTHORIZED, 'Неверный пароль', 401);
  }

  // Блокировка при активных заказах — и как покупателя, и как продавца.
  const activeBuyer = await prisma.order.findFirst({
    where: { buyerId: userId, status: { in: [...LOCKED_ORDER_STATUSES] } },
    select: { id: true, status: true },
  });
  if (activeBuyer) {
    throw new AppError(
      errorCodes.CONFLICT,
      `Нельзя удалить аккаунт: есть активный заказ ${activeBuyer.id.slice(0, 8)} (статус ${activeBuyer.status})`,
      409
    );
  }
  const activeSeller = await prisma.order.findFirst({
    where: { listing: { sellerId: userId }, status: { in: [...LOCKED_ORDER_STATUSES] } },
    select: { id: true, status: true },
  });
  if (activeSeller) {
    throw new AppError(
      errorCodes.CONFLICT,
      `Нельзя удалить аккаунт: есть активный заказ ${activeSeller.id.slice(0, 8)} (статус ${activeSeller.status})`,
      409
    );
  }

  // S3-ключи собираем ДО транзакции: ключ аватара выводим из public URL,
  // фото объявлений и сообщений — из БД.
  const s3Keys: string[] = [];
  if (user.avatarUrl && user.avatarUrl.startsWith(`${env.S3_PUBLIC_BASE_URL}/`)) {
    s3Keys.push(user.avatarUrl.slice(env.S3_PUBLIC_BASE_URL.length + 1));
  }
  const listingImages = await prisma.listingImage.findMany({
    where: { listing: { sellerId: userId } },
    select: { key: true },
  });
  s3Keys.push(...listingImages.map((i) => i.key));
  const chatImages = await prisma.message.findMany({
    where: { senderId: userId },
    select: { imageKey: true, imageThumbKey: true },
  });
  for (const m of chatImages) {
    if (m.imageKey) s3Keys.push(m.imageKey);
    if (m.imageThumbKey) s3Keys.push(m.imageThumbKey);
  }

  await prisma.$transaction(async (tx) => {
    // Сессии: RefreshTokenFamily не имеет FK — удаляем вручную.
    await tx.refreshTokenFamily.deleteMany({ where: { userId } });
    // Жалобы, написанные пользователем.
    await tx.report.deleteMany({ where: { authorId: userId } });
    // Жалобы на сообщения пользователя: связь только по targetId-строке (без FK),
    // поэтому чистим raw-SQL до удаления самих сообщений.
    const ownMessages = await tx.message.findMany({
      where: { senderId: userId },
      select: { id: true },
    });
    const ownMessageIds = ownMessages.map((m) => m.id);
    if (ownMessageIds.length > 0) {
      await tx.$executeRaw`DELETE FROM "Report" WHERE "targetType" = 'MESSAGE' AND "targetId" = ANY(${ownMessageIds})`;
    }
    // Отзывы в обе стороны.
    await tx.review.deleteMany({ where: { authorId: userId } });
    await tx.review.deleteMany({ where: { revieweeId: userId } });
    // Чаты пользователя (hard delete для обоих: каскад сносит сообщения и участников).
    const participations = await tx.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    const conversationIds = [...new Set(participations.map((p) => p.conversationId))];
    if (conversationIds.length > 0) {
      await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    }
    // Закрытые заказы (активных уже нет — проверено выше). Order.listingId — Restrict,
    // поэтому заказы удаляем до объявлений.
    await tx.order.deleteMany({
      where: { OR: [{ buyerId: userId }, { listing: { sellerId: userId } }] },
    });
    // Объявления (каскад сносит фото, избранное, просмотры).
    await tx.listing.deleteMany({ where: { sellerId: userId } });
    // Остальное (избранное, просмотры, коды верификации, подписки) — Cascade от User.
    await tx.user.delete({ where: { id: userId } });
  });

  if (s3Keys.length > 0) {
    await enqueueS3Delete(s3Keys).catch(() => undefined);
  }
  // Остальные сессии умирают сами: loadUser вернёт null. Auth-кэш чистим сразу.
  const redis = getRedis();
  await redis.del(`user:auth:${userId}`).catch(() => undefined);
  logSecurityEvent('account_deleted', { userId });
}
