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
import { requireTurnstile } from '../middleware/turnstile.js';
import { createPresignedUpload, deleteObject, verifyImageObject } from '../lib/s3.js';
import { processImage } from '../services/imageService.js';
import { getRedis } from '../lib/redis.js';
import {
  getListingById,
  searchListings,
} from '../services/listingService.js';
import { moderateListingContent } from '../services/moderationService.js';
import { logSecurityEvent } from '../lib/logger.js';

const router: Router = Router();

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
  requireTurnstile,
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
    if (!isOwner && req.userRole !== 'ADMIN') {
      throw new AppError(errorCodes.FORBIDDEN, 'Удалять может только владелец', 403);
    }
    const images = await prisma.listingImage.findMany({ where: { listingId: listing.id }, select: { key: true } });
    await prisma.listing.delete({ where: { id: listing.id } });
    await Promise.all(images.map((i) => deleteObject(i.key)));
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
