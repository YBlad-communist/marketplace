import { Router } from 'express';
import { prisma } from '@marketplace/db';
import {
  listingCreateSchema,
  listingQuerySchema,
  listingUpdateSchema,
  imagePresignSchema,
  createImagesDoneSchema,
  AppError,
  errorCodes,
} from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireCaptcha } from '../middleware/captcha.js';
import { createPresignedUpload, deleteObject, verifyImageObject } from '../lib/s3.js';
import { processImage } from '../services/imageService.js';
import { enqueueS3Delete } from '../services/notificationService.js';
import { getRedis } from '../lib/redis.js';
import {
  getListingById,
  searchListings,
} from '../services/listingService.js';
import { moderateListingContent } from '../services/moderationService.js';
import { logSecurityEvent } from '../lib/logger.js';

const router: Router = Router();

/** Заказы, из-за которых объявление нельзя редактировать/удалять */
const LOCKED_ORDER_STATUSES = ['PENDING', 'PAID', 'RELEASING', 'REFUNDING', 'DISPUTED'] as const;

async function assertNoActiveOrder(listingId: string, action: string): Promise<void> {
  const active = await prisma.order.findFirst({
    where: { listingId, status: { in: [...LOCKED_ORDER_STATUSES] } },
    select: { id: true, status: true },
  });
  if (active) {
    throw new AppError(
      errorCodes.CONFLICT,
      `Нельзя ${action}: по объявлению есть активный заказ ${active.id.slice(0, 8)} (статус ${active.status})`,
      409
    );
  }
}

/**
 * Удаление объявления блокируется ЛЮБОЙ историей заказов: Order.listingId
 * связан RESTRICT-FK, и даже закрытые (REFUNDED/RELEASED) заказы нельзя
 * «стереть» вместе с объявлением — иначе теряются следы эскроу-операций.
 * Возвращаем понятный 409, а не «плавающий» 500 от Postgres.
 */
async function assertNoOrderHistory(listingId: string): Promise<void> {
  const count = await prisma.order.count({ where: { listingId } });
  if (count > 0) {
    throw new AppError(
      errorCodes.CONFLICT,
      'Нельзя удалить объявление: по нему есть история заказов',
      409
    );
  }
}

async function assertOwnerOrModerator(listingId: string, userId: string, role: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, sellerId: true },
  });
  if (!listing) throw new AppError(errorCodes.NOT_FOUND, 'Объявление не найдено', 404);
  const isOwner = listing.sellerId === userId;
  const isStaff = role === 'ADMIN' || role === 'MODERATOR';
  if (!isOwner && !isStaff) {
    logSecurityEvent('idor_attempt', { userId, listingId });
    throw new AppError(errorCodes.FORBIDDEN, 'Нет доступа к этому объявлению', 403);
  }
  return { listing, isOwner };
}

/** Ключи, выданные пользователю на presigned upload (сессия 15 мин) */
async function takePresignedKeys(userId: string): Promise<Set<string>> {
  const redis = getRedis();
  const setKey = `presign:user:${userId}`;
  const keys = await redis.smembers(setKey);
  await redis.del(setKey);
  return new Set(keys);
}

async function registerPresignedKey(userId: string, key: string): Promise<void> {
  const redis = getRedis();
  await redis.sadd(`presign:user:${userId}`, key);
  await redis.expire(`presign:user:${userId}`, 60 * 15);
}

async function updateSearchTs(listingId: string, title: string, description: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "Listing" SET "searchTs" = to_tsvector('simple', ${title} || ' ' || ${description}) WHERE id = ${listingId}`;
}

router.get(
  '/',
  optionalAuthenticate,
  validate(listingQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      const result = await searchListings(req.query as never, req.userId);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', optionalAuthenticate, async (req, res, next) => {
  try {
    const listing = await getListingById(req.params.id, req.userId, req.ip);
    res.json({ data: { listing } });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  authenticate,
  requireCaptcha,
  rateLimit({ key: 'listing:create', windowMs: 10 * 60_000, max: 10, log: true }),
  validate(listingCreateSchema),
  async (req, res, next) => {
    try {
      const input = req.body;
      const moderation = await moderateListingContent({
        title: input.title,
        description: input.description,
      });
      const status = moderation.approve ? 'ACTIVE' : 'REJECTED';

      const listing = await prisma.listing.create({
        data: {
          title: input.title,
          description: input.description,
          price: input.price,
          currency: input.currency,
          status,
          sellerId: req.userId!,
          categoryId: input.categoryId,
          city: input.city,
          lat: input.lat,
          lng: input.lng,
          attributes: input.attributes ?? {},
          moderationNote: moderation.approve ? null : moderation.reason,
        },
      });

      const issued = await takePresignedKeys(req.userId!);
      const processedImages: { key: string; url: string; thumbUrl: string; width: number; height: number; position: number }[] = [];

      try {
        for (const img of input.imageKeys ?? []) {
          if (!issued.has(img.key)) {
            throw new AppError(errorCodes.VALIDATION, 'Файл не был загружен через presigned URL', 400);
          }
          await verifyImageObject(img.key);
          const processed = await processImage(img.key);
          await deleteObject(img.key);
          processedImages.push({
            key: processed.fullKey,
            url: processed.publicUrl,
            thumbUrl: processed.thumbUrl,
            width: processed.width,
            height: processed.height,
            position: img.position,
          });
        }
        if (processedImages.length > 0) {
          await prisma.listingImage.createMany({
            data: processedImages.map((p) => ({ ...p, listingId: listing.id })),
          });
        }
      } catch (err) {
        await prisma.listing.delete({ where: { id: listing.id } }).catch(() => undefined);
        throw err;
      }

      await updateSearchTs(listing.id, listing.title, listing.description);

      res.status(201).json({
        data: {
          listing: { id: listing.id, status },
          moderationNote: moderation.reason ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  validate(listingUpdateSchema),
  async (req, res, next) => {
    try {
      const { listing, isOwner } = await assertOwnerOrModerator(req.params.id, req.userId!, req.userRole!);
      if (!isOwner) {
        // модератор может менять только статус
        throw new AppError(errorCodes.FORBIDDEN, 'Редактировать может только владелец', 403);
      }
      const data: Record<string, unknown> = { ...req.body };
      delete data.imageKeys;

      // Цена и статус участвуют в исполнении активных заказов (эскроу считает
      // fee от price, статус RESERVED предотвращает повторные покупки):
      // менять их, пока висит заказ, нельзя — 409, а не тихий разъезд данных.
      if (data.price !== undefined || data.status !== undefined) {
        await assertNoActiveOrder(listing.id, 'изменить цену или статус');
      }

      const updated = await prisma.listing.update({
        where: { id: listing.id },
        data: data as never,
      });
      if (data.title || data.description) {
        await updateSearchTs(listing.id, updated.title, updated.description);
      }
      res.json({ data: { listing: { id: updated.id, status: updated.status } } });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { listing, isOwner } = await assertOwnerOrModerator(req.params.id, req.userId!, req.userRole!);
    const isStaff = req.userRole === 'ADMIN' || req.userRole === 'MODERATOR';
    if (!isOwner && !isStaff) {
      throw new AppError(errorCodes.FORBIDDEN, 'Удалять может только владелец или модератор', 403);
    }
    // Явная проверка до удаления: любой заказ (активный или закрытый) блочит
    // удаление объявления из-за RESTRICT-FK. Без неё Postgres отдал бы 23001
    // -> 500 с нечитаемым текстом (см. toAppError как страховку).
    await assertNoOrderHistory(listing.id);
    const images = await prisma.listingImage.findMany({ where: { listingId: listing.id }, select: { key: true } });
    await prisma.listing.delete({ where: { id: listing.id } });
    if (!isOwner) {
      logSecurityEvent('listing_deleted_by_staff', {
        listingId: listing.id,
        staffId: req.userId,
        role: req.userRole,
      });
    }
    // Файлы из корзины убирает фоновая джоба S3 с ретраями — если MinIO упал,
    // объекты не остаются сиротами, а ответ API не зависит от хранилища.
    await enqueueS3Delete(images.map((i) => i.key)).catch(() => {
      logSecurityEvent('s3_delete_enqueue_failed', { listingId: listing.id });
    });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/images',
  authenticate,
  validate(imagePresignSchema, 'body'),
  async (req, res, next) => {
    try {
      await assertOwnerOrModerator(req.params.id, req.userId!, req.userRole!);
      const { mime, extension, sizeBytes } = req.body;
      const presign = await createPresignedUpload(mime, extension, sizeBytes);
      await registerPresignedKey(req.userId!, presign.key);
      res.json({ data: presign });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/images/done',
  authenticate,
  validate(createImagesDoneSchema),
  async (req, res, next) => {
    try {
      const { listing, isOwner } = await assertOwnerOrModerator(req.params.id, req.userId!, req.userRole!);
      if (!isOwner) {
        throw new AppError(errorCodes.FORBIDDEN, 'Только владелец может добавлять фото', 403);
      }
      const issued = await takePresignedKeys(req.userId!);
      const results: { key: string; url: string; thumbUrl: string; width: number; height: number; position: number }[] = [];
      for (const img of req.body.imageKeys) {
        if (!issued.has(img.key)) {
          throw new AppError(errorCodes.VALIDATION, 'Файл не был загружен через presigned URL', 400);
        }
        await verifyImageObject(img.key);
        const processed = await processImage(img.key);
        await deleteObject(img.key);
        results.push({
          key: processed.fullKey,
          url: processed.publicUrl,
          thumbUrl: processed.thumbUrl,
          width: processed.width,
          height: processed.height,
          position: img.position,
        });
      }
      await prisma.listingImage.createMany({
        data: results.map((r) => ({ ...r, listingId: listing.id })),
      });
      const images = await prisma.listingImage.findMany({
        where: { listingId: listing.id },
        orderBy: { position: 'asc' },
      });
      res.json({ data: { images } });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id/images/:imageId', authenticate, async (req, res, next) => {
  try {
    const { listing } = await assertOwnerOrModerator(req.params.id, req.userId!, req.userRole!);
    const image = await prisma.listingImage.findUnique({ where: { id: req.params.imageId } });
    if (!image || image.listingId !== listing.id) {
      throw new AppError(errorCodes.NOT_FOUND, 'Фото не найдено', 404);
    }
    await prisma.listingImage.delete({ where: { id: image.id } });
    await enqueueS3Delete([image.key]).catch(() => {
      logSecurityEvent('s3_delete_enqueue_failed', { listingId: listing.id, imageId: image.id });
    });
    const images = await prisma.listingImage.findMany({
      where: { listingId: listing.id },
      orderBy: { position: 'asc' },
    });
    res.json({ data: { images } });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/favorite', authenticate, async (req, res, next) => {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
    if (!listing) throw new AppError(errorCodes.NOT_FOUND, 'Объявление не найдено', 404);
    if (listing.sellerId === req.userId) {
      throw new AppError(errorCodes.VALIDATION, 'Нельзя добавить в избранное своё объявление', 400);
    }
    await prisma.favorite.upsert({
      where: { userId_listingId: { userId: req.userId!, listingId: listing.id } },
      update: {},
      create: { userId: req.userId!, listingId: listing.id },
    });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/favorite', authenticate, async (req, res, next) => {
  try {
    await prisma.favorite.deleteMany({
      where: { userId: req.userId!, listingId: req.params.id },
    });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
