import { Router } from 'express';
import { prisma, Prisma } from '@marketplace/db';
import {
  adminModerationSchema,
  adminBanSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  regionCreateSchema,
  regionUpdateSchema,
  cityCreateSchema,
  cityUpdateSchema,
  slugifyName,
  AppError,
  errorCodes,
} from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate, requireModerator, requireAdmin } from '../middleware/auth.js';
import { approveListing, rejectListing } from '../services/moderationService.js';
import { logSecurityEvent } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';

const router: Router = Router();

// Без authenticate req.userId/req.userRole не выставлены, и requireRole
// отдавал бы 401 каждому запросу (баг с первого коммита — админка была мертва).
router.use(authenticate);
router.use(requireModerator);

router.get('/listings/pending', async (req, res, next) => {
  try {
    const listings = await prisma.listing.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { seller: { select: { id: true, name: true } }, images: { take: 1 } },
    });
    res.json({ data: { listings: listings.map((l) => ({ ...l, price: Number(l.price) })) } });
  } catch (err) {
    next(err);
  }
});

router.post('/listings/:id/moderate', validate(adminModerationSchema), async (req, res, next) => {
  try {
    const { action, reason } = req.body;
    if (action === 'APPROVE') {
      await approveListing(req.params.id, req.userId!);
    } else {
      await rejectListing(req.params.id, req.userId!, reason);
    }
    logSecurityEvent('listing_moderated', { listingId: req.params.id, action, moderator: req.userId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/reports', async (req, res, next) => {
  try {
    const reports = await prisma.report.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { author: { select: { id: true, name: true } } },
    });
    res.json({ data: { reports } });
  } catch (err) {
    next(err);
  }
});

router.post('/reports/:id/resolve', async (req, res, next) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) throw new AppError(errorCodes.NOT_FOUND, 'Жалоба не найдена', 404);
    const action = req.body.action === 'RESOLVED' ? 'RESOLVED' : 'DISMISSED';
    await prisma.report.update({
      where: { id: report.id },
      data: { status: action, resolvedBy: req.userId },
    });
    if (action === 'RESOLVED' && report.targetType === 'LISTING') {
      await rejectListing(report.targetId, req.userId!, 'Жалоба подтверждена');
    }
    logSecurityEvent('report_resolved', { reportId: report.id, action, moderator: req.userId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.use(requireAdmin);

/** P2002 (unique) → читаемый 409 вместо 500. */
function handleUnique(err: unknown, entity: string): void {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new AppError(errorCodes.CONFLICT, `Такой slug уже занят (${entity})`, 409);
  }
  throw err;
}

/** Все id поддерева категории (включая саму) — итеративно, глубина любая. */
async function subtreeIds(rootId: string): Promise<string[]> {
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const batch = queue.splice(0, 100);
    const children = await prisma.category.findMany({
      where: { parentId: { in: batch } },
      select: { id: true },
    });
    for (const c of children) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}

/** Проверка, что newParentId не создаёт цикл (не потомок и не сама категория). */
async function assertNoCycle(categoryId: string, newParentId: string): Promise<void> {
  if (newParentId === categoryId) {
    throw new AppError(errorCodes.VALIDATION, 'Категория не может быть родителем самой себя', 400);
  }
  const descendants = await subtreeIds(categoryId);
  if (descendants.includes(newParentId)) {
    throw new AppError(errorCodes.VALIDATION, 'Нельзя перенести категорию в её же поддерево', 400);
  }
}

// ---------- Категории ----------

router.post('/categories', validate(categoryCreateSchema), async (req, res, next) => {
  try {
    const { name, parentId, sortOrder } = req.body;
    const slug = req.body.slug ?? slugifyName(name);
    if (!slug) throw new AppError(errorCodes.VALIDATION, 'Не удалось образовать slug из названия', 400);
    if (parentId) {
      const parent = await prisma.category.findUnique({ where: { id: parentId } });
      if (!parent) throw new AppError(errorCodes.NOT_FOUND, 'Родительская категория не найдена', 404);
    }
    const category = await prisma.category
      .create({ data: { name, slug, parentId: parentId ?? null, sortOrder: sortOrder ?? 0 } })
      .catch((err) => {
        handleUnique(err, 'категория');
        throw err;
      });
    logSecurityEvent('category_created', { categoryId: category.id, admin: req.userId });
    res.status(201).json({ data: { category } });
  } catch (err) {
    next(err);
  }
});

router.patch('/categories/:id', validate(categoryUpdateSchema), async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!category) throw new AppError(errorCodes.NOT_FOUND, 'Категория не найдена', 404);
    const { name, parentId } = req.body;
    let slug = req.body.slug as string | undefined;
    if (name && !slug) slug = slugifyName(name);
    if (parentId !== undefined && parentId !== null) {
      const parent = await prisma.category.findUnique({ where: { id: parentId } });
      if (!parent) throw new AppError(errorCodes.NOT_FOUND, 'Родительская категория не найдена', 404);
      await assertNoCycle(category.id, parentId);
    }
    const updated = await prisma.category
      .update({
        where: { id: category.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(parentId !== undefined ? { parentId } : {}),
          ...(req.body.sortOrder !== undefined ? { sortOrder: req.body.sortOrder } : {}),
          ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {}),
        },
      })
      .catch((err) => {
        handleUnique(err, 'категория');
        throw err;
      });
    logSecurityEvent('category_updated', { categoryId: updated.id, admin: req.userId });
    res.json({ data: { category: updated } });
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!category) throw new AppError(errorCodes.NOT_FOUND, 'Категория не найдена', 404);
    // Удаляем каскадно с детьми, но только если во всём поддереве нет объявлений.
    const ids = await subtreeIds(category.id);
    const listingsCount = await prisma.listing.count({ where: { categoryId: { in: ids } } });
    if (listingsCount > 0) {
      throw new AppError(
        errorCodes.CONFLICT,
        `Нельзя удалить: в категории и подкатегориях есть объявления (${listingsCount})`,
        409
      );
    }
    // Атрибуты сносятся каскадом по FK, детей удаляем явно (в схеме SetNull).
    await prisma.category.deleteMany({ where: { id: { in: ids } } });
    logSecurityEvent('category_deleted', { categoryId: category.id, admin: req.userId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// ---------- Регионы ----------

router.post('/regions', validate(regionCreateSchema), async (req, res, next) => {
  try {
    const slug = req.body.slug ?? slugifyName(req.body.name);
    if (!slug) throw new AppError(errorCodes.VALIDATION, 'Не удалось образовать slug из названия', 400);
    const region = await prisma.region
      .create({ data: { name: req.body.name, slug, sortOrder: req.body.sortOrder ?? 0 } })
      .catch((err) => {
        handleUnique(err, 'регион');
        throw err;
      });
    res.status(201).json({ data: { region } });
  } catch (err) {
    next(err);
  }
});

router.patch('/regions/:id', validate(regionUpdateSchema), async (req, res, next) => {
  try {
    const region = await prisma.region.findUnique({ where: { id: req.params.id } });
    if (!region) throw new AppError(errorCodes.NOT_FOUND, 'Регион не найден', 404);
    const updated = await prisma.region
      .update({
        where: { id: region.id },
        data: {
          ...(req.body.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body.slug !== undefined ? { slug: req.body.slug } : {}),
          ...(req.body.sortOrder !== undefined ? { sortOrder: req.body.sortOrder } : {}),
          ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {}),
        },
      })
      .catch((err) => {
        handleUnique(err, 'регион');
        throw err;
      });
    res.json({ data: { region: updated } });
  } catch (err) {
    next(err);
  }
});

router.delete('/regions/:id', async (req, res, next) => {
  try {
    const region = await prisma.region.findUnique({ where: { id: req.params.id } });
    if (!region) throw new AppError(errorCodes.NOT_FOUND, 'Регион не найден', 404);
    // Города сносятся каскадом по FK; у объявлений cityId обнуляется (SetNull),
    // строковое city остаётся — данные не теряются.
    await prisma.region.delete({ where: { id: region.id } });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// ---------- Города ----------

router.post('/cities', validate(cityCreateSchema), async (req, res, next) => {
  try {
    const region = await prisma.region.findUnique({ where: { id: req.body.regionId } });
    if (!region) throw new AppError(errorCodes.NOT_FOUND, 'Регион не найден', 404);
    const slug = req.body.slug ?? slugifyName(req.body.name);
    if (!slug) throw new AppError(errorCodes.VALIDATION, 'Не удалось образовать slug из названия', 400);
    const city = await prisma.city
      .create({
        data: { name: req.body.name, slug, regionId: req.body.regionId, sortOrder: req.body.sortOrder ?? 0 },
      })
      .catch((err) => {
        handleUnique(err, 'город');
        throw err;
      });
    res.status(201).json({ data: { city } });
  } catch (err) {
    next(err);
  }
});

router.patch('/cities/:id', validate(cityUpdateSchema), async (req, res, next) => {
  try {
    const city = await prisma.city.findUnique({ where: { id: req.params.id } });
    if (!city) throw new AppError(errorCodes.NOT_FOUND, 'Город не найден', 404);
    if (req.body.regionId) {
      const region = await prisma.region.findUnique({ where: { id: req.body.regionId } });
      if (!region) throw new AppError(errorCodes.NOT_FOUND, 'Регион не найден', 404);
    }
    const updated = await prisma.city
      .update({
        where: { id: city.id },
        data: {
          ...(req.body.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body.regionId !== undefined ? { regionId: req.body.regionId } : {}),
          ...(req.body.slug !== undefined ? { slug: req.body.slug } : {}),
          ...(req.body.sortOrder !== undefined ? { sortOrder: req.body.sortOrder } : {}),
          ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {}),
        },
      })
      .catch((err) => {
        handleUnique(err, 'город');
        throw err;
      });
    res.json({ data: { city: updated } });
  } catch (err) {
    next(err);
  }
});

router.delete('/cities/:id', async (req, res, next) => {
  try {
    const city = await prisma.city.findUnique({ where: { id: req.params.id } });
    if (!city) throw new AppError(errorCodes.NOT_FOUND, 'Город не найден', 404);
    // У объявлений cityId обнуляется (SetNull), строковое city остаётся.
    await prisma.city.delete({ where: { id: city.id } });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/ban', validate(adminBanSchema), async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
    if (user.role === 'ADMIN') {
      throw new AppError(errorCodes.FORBIDDEN, 'Нельзя забанить администратора', 403);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isBanned: req.body.banned,
        banReason: req.body.banned ? (req.body.reason ?? 'Нарушение правил') : null,
      },
    });
    // Инвалидируем кэш авторизации и на бан, и на разбан: иначе забаненный
    // до минуты ходит по API как обычный, а разбаненный ещё минуту — как забаненный.
    const redis = getRedis();
    await redis.del(`user:auth:${user.id}`);
    if (req.body.banned) {
      await prisma.refreshTokenFamily.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    logSecurityEvent('user_banned', { userId: user.id, banned: req.body.banned, admin: req.userId });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isBanned: true,
        isVerified: true,
        createdAt: true,
      },
    });
    res.json({ data: { users } });
  } catch (err) {
    next(err);
  }
});

export default router;
