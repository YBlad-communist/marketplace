import argon2 from 'argon2';
import { prisma, Prisma } from '@marketplace/db';
import { ACTIVE_ORDER_STATUSES, AppError, errorCodes } from '@marketplace/shared';
import { getRedis } from '../lib/redis.js';
import { logSecurityEvent } from '../lib/logger.js';
import { env } from '../config.js';
import { enqueueS3Delete } from './notificationService.js';

/** Статусы заказов, блокирующие удаление аккаунта (те же, что блокируют удаление объявления). */
/** Активные заказы, блокирующие удаление аккаунта (в т.ч. SHIPPED/спор). */
const LOCKED_ORDER_STATUSES = ACTIVE_ORDER_STATUSES;

/**
 * П.32: служебный «удалённый пользователь» — на него анонимизируются
 * заказы (RELEASED/REFUNDED), отзывы других людей о пользователе,
 * listing-и с сохранёнными заказами и сообщения в чатах, где второй
 * участник остаётся. FK-ограничения satisfied, реальные PII уходят.
 */
const DELETED_USER_ID = '__system_deleted__';
const DELETED_USER_NAME = 'Удалённый пользователь';

async function ensureDeletedUser(tx: Prisma.TransactionClient): Promise<void> {
  await tx.user.upsert({
    where: { id: DELETED_USER_ID },
    update: {},
    create: {
      id: DELETED_USER_ID,
      name: DELETED_USER_NAME,
      phone: null,
      email: null,
      passwordHash: null,
      isVerified: false,
      isBanned: true,
      banReason: 'Служебный аккаунт: анонимизированные данные удалённых пользователей',
    },
  });
}

/**
 * Ядро удаления аккаунта (без проверки пароля): блокировка при активных
 * заказах, сбор S3-ключей, транзакция, фоновая чистка файлов и auth-кэша.
 * Порядок важен из-за Restrict-связей: сначала всё, что ссылается на
 * пользователя/его сущности, потом сами сущности.
 */
async function performAccountDeletion(user: {
  id: string;
  avatarUrl: string | null;
}): Promise<void> {
  const userId = user.id;

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

  // S3-ключи собираем ДО транзакции. Фото объявлений и сообщений берём из
  // записей БД. Строку avatarUrl НЕ доверяем (п.18 аудита): раньше её можно
  // было задать через PATCH /me и при удалении аккаунта «удалить» чужой файл.
  // Ключ аватара принимаем только в точном формате, который генерирует
  // сервер: images/<16 символов base64url>.webp — подставить чужой ключ
  // через эту строку нельзя.
  const s3Keys: string[] = [];
  const avatarBase = `${env.S3_PUBLIC_BASE_URL}/`;
  if (user.avatarUrl?.startsWith(avatarBase)) {
    const avatarKey = user.avatarUrl.slice(avatarBase.length);
    if (/^images\/[A-Za-z0-9_-]{16}\.webp$/.test(avatarKey)) {
      s3Keys.push(avatarKey);
    }
  }
  // Фото удаляем ТОЛЬКО у объявлений без заказов (они будут стёрты каскадом).
  // Объявления с терминальными заказами п.32 сохраняет (анонимизирует) —
  // их фото остаются в S3 вместе со строками ListingImage. Фото в чатах
  // тоже сохраняем: п.30 оставляет чат второй стороне, и медиа её истории
  // не должны стать битыми (поведение мессенджеров при удалении аккаунта).
  const listingImages = await prisma.listingImage.findMany({
    where: { listing: { sellerId: userId, orders: { none: {} } } },
    select: { key: true },
  });
  s3Keys.push(...listingImages.map((i) => i.key));

  await prisma.$transaction(async (tx) => {
    // П.32: служебный аккаунт для анонимизированных ссылок (заказы, отзывы,
    // сообщения, объявления с историей сделок).
    await ensureDeletedUser(tx);
    // Сессии: RefreshTokenFamily не имеет FK — удаляем вручную.
    await tx.refreshTokenFamily.deleteMany({ where: { userId } });
    // Жалобы, написанные пользователем.
    await tx.report.deleteMany({ where: { authorId: userId } });
    // Жалобы на сообщения пользователя: связь только по targetId-строке (без FK),
    // поэтому чистим raw-SQL.
    const ownMessages = await tx.message.findMany({
      where: { senderId: userId },
      select: { id: true },
    });
    const ownMessageIds = ownMessages.map((m) => m.id);
    if (ownMessageIds.length > 0) {
      await tx.$executeRaw`DELETE FROM "Report" WHERE "targetType" = 'MESSAGE' AND "targetId" = ANY(${ownMessageIds})`;
    }
    // Отзывы, написанные пользователем — удаляем (его собственный контент).
    await tx.review.deleteMany({ where: { authorId: userId } });
    // П.32: отзывы ДРУГИХ о пользователе сохраняем, анонимизируя reviewee.
    // Отзывы с orderId анонимизируются без коллизий: уникальность
    // (authorId, revieweeId, orderId) включает orderId, а автор пишет
    // не более одного отзыва на сделку.
    await tx.review.updateMany({
      where: { revieweeId: userId, orderId: { not: null } },
      data: { revieweeId: DELETED_USER_ID },
    });
    // Свободные отзывы (без сделки) контролируются частичным уникальным
    // индексом (authorId, revieweeId) WHERE orderId IS NULL: если у автора
    // уже есть такой отзыв о sentinel (он удалял двух пользователей),
    // коллизию обходим удалением второго — иначе анонимизация упала бы
    // P2002 и весь удаление аккаунта откатилось.
    const freeReviews = await tx.review.findMany({
      where: { revieweeId: userId, orderId: null },
      select: { id: true, authorId: true },
    });
    if (freeReviews.length > 0) {
      const sentinelAuthors = await tx.review.findMany({
        where: { revieweeId: DELETED_USER_ID, orderId: null },
        select: { authorId: true },
        distinct: ['authorId'],
      });
      const collision = new Set(sentinelAuthors.map((r) => r.authorId));
      const reassignIds = freeReviews.filter((r) => !collision.has(r.authorId)).map((r) => r.id);
      const dropIds = freeReviews.filter((r) => collision.has(r.authorId)).map((r) => r.id);
      if (dropIds.length > 0) {
        await tx.review.deleteMany({ where: { id: { in: dropIds } } });
      }
      if (reassignIds.length > 0) {
        await tx.review.updateMany({
          where: { id: { in: reassignIds } },
          data: { revieweeId: DELETED_USER_ID },
        });
      }
    }
    // П.30/п.32: чаты второй стороны НЕ удаляем. Сообщения пользователя
    // перепривязываем к sentinel; фото сообщений остаются (история чата
    // собеседника не должна ломаться).
    await tx.message.updateMany({
      where: { senderId: userId },
      data: { senderId: DELETED_USER_ID },
    });
    await tx.conversationParticipant.deleteMany({ where: { userId } });
    // Чаты, оставшиеся без участников (второй ушёл раньше), убираем.
    await tx.conversation.deleteMany({ where: { participants: { none: {} } } });
    // Чаты, привязанные к объявлениям БЕЗ заказов (они будут удалены
    // каскадом), отвязываем заранее — чат второй стороны не должен сгореть.
    // Чаты у объявлений с заказами сохраняют ссылку на оставленное объявление.
    await tx.conversation.updateMany({
      where: { listing: { sellerId: userId, orders: { none: {} } } },
      data: { listingId: null },
    });
    // П.32: терминальные заказы (RELEASED/REFUNDED — активных уже нет)
    // НЕ удаляем: анонимизируем покупателя, сохраняя финансовую запись.
    await tx.order.updateMany({
      where: { buyerId: userId },
      data: { buyerId: DELETED_USER_ID },
    });
    // Объявления с заказами: продавец → sentinel, статус ARCHIVED
    // (анонимизация вместо удаления — Order.listingId Restrict).
    const listingsWithOrders = await tx.order.findMany({
      where: { listing: { sellerId: userId } },
      select: { listingId: true },
      distinct: ['listingId'],
    });
    const keptListingIds = listingsWithOrders.map((o) => o.listingId);
    if (keptListingIds.length > 0) {
      await tx.listing.updateMany({
        where: { id: { in: keptListingIds } },
        data: { sellerId: DELETED_USER_ID, status: 'ARCHIVED' },
      });
    }
    // Остальные объявления удаляем (каскад сносит фото, избранное, просмотры).
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
}

/**
 * Самоудаление аккаунта: подтверждение паролем обязательно.
 * Активные заказы (покупатель или продавец) блокируют удаление — 409.
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

  await performAccountDeletion(user);
  logSecurityEvent('account_deleted', { userId });
}

/** Полное удаление аккаунта администратором (без пароля пользователя). */
export async function deleteAccountByAdmin(targetId: string, actorId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: targetId } });
  if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);

  await performAccountDeletion(user);
  logSecurityEvent('account_deleted_by_admin', { userId: targetId, admin: actorId });
}
