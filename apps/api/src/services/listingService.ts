import { prisma, Prisma, ListingStatus } from '@marketplace/db';
import { AppError, errorCodes, ListingQueryInput, CURSOR_PAGE_SIZE } from '@marketplace/shared';
import { getRedis } from '../lib/redis.js';

const listingInclude = {
  images: { orderBy: { position: 'asc' as const }, select: { id: true, url: true, thumbUrl: true, position: true } },
  seller: {
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      city: true,
      rating: true,
      ratingCount: true,
      isVerified: true,
    },
  },
  category: { select: { id: true, name: true, slug: true, parent: { select: { id: true, name: true, slug: true } } } },
};

type SearchRow = { id: string; rank: number };

interface SortOptions {
  field: 'createdAt' | 'price';
  dir: 'asc' | 'desc';
}

export function sortOptions(sort: string): SortOptions {  switch (sort) {
    case 'price_asc':
      return { field: 'price', dir: 'asc' };
    case 'price_desc':
      return { field: 'price', dir: 'desc' };
    case 'date_asc':
      return { field: 'createdAt', dir: 'asc' };
    case 'date_desc':
    default:
      return { field: 'createdAt', dir: 'desc' };
  }
}

export function encodeCursor(primary: Date | number, id: string): string {
  const value = primary instanceof Date ? primary.toISOString() : String(primary);
  return Buffer.from(`${value}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { primary: Date | number; id: string } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep === -1) throw new Error('bad cursor');
    const value = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const num = Number(value);
    const primary = Number.isFinite(num) ? num : new Date(value);
    return { primary, id };
  } catch {
    throw new AppError(errorCodes.VALIDATION, 'Некорректный курсор', 400);
  }
}

function buildWhere(input: ListingQueryInput): Prisma.ListingWhereInput {
  const where: Prisma.ListingWhereInput = {};
  // Статус — опциональный фильтр: учитывается только если передан явно.
  // Дефолт ACTIVE сохраняется для публичного контекста (без sellerId);
  // с sellerId (кабинет продавца) без статуса отдаются все объявления.
  if (input.status) {
    where.status = input.status as ListingStatus;
  } else if (!input.sellerId) {
    where.status = 'ACTIVE';
  }
  if (input.category) {
    where.OR = [{ categoryId: input.category }, { category: { parentId: input.category } }];
  }
  if (input.city) where.city = input.city;
  if (input.sellerId) where.sellerId = input.sellerId;
  if (input.favoritesOf) where.favoritedBy = { some: { userId: input.favoritesOf } };

  const price: Prisma.FloatFilter | Prisma.DecimalFilter = {};
  if (input.minPrice !== undefined) price.gte = input.minPrice;
  if (input.maxPrice !== undefined) price.lte = input.maxPrice;
  if (input.minPrice !== undefined || input.maxPrice !== undefined) {
    where.price = price as Prisma.DecimalFilter;
  }

  if (input.lat !== undefined && input.lng !== undefined && input.radiusKm) {
    const R = 6371;
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    const radius = Number(input.radiusKm);
    where.lat = { gte: lat - radius / R, lte: lat + radius / R };
    where.lng = { gte: lng - radius / (R * Math.cos((lat * Math.PI) / 180)), lte: lng + radius / (R * Math.cos((lat * Math.PI) / 180)) };
  }

  if (input.attrs) {
    const attrFilters: Prisma.ListingWhereInput[] = [];
    for (const [key, value] of Object.entries(input.attrs)) {
      if (value && typeof value === 'object' && ('min' in value || 'max' in value)) {
        const range = value as { min?: number; max?: number };
        // JSON-диапазоны поддерживаются Prisma ограниченно — фильтруем только
        // точные совпадения строк/чисел/булевых, диапазоны игнорируем,
        // чтобы не ронять запрос runtime-ошибкой.
        void range;
        continue;
      } else if (value !== null && value !== undefined) {
        attrFilters.push({ attributes: { path: [key], equals: value as never } });
      }
    }
    if (attrFilters.length > 0) {
      const baseAnd = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
      where.AND = [...baseAnd, ...attrFilters] as Prisma.ListingWhereInput['AND'];
    }
  }
  return where;
}

/** Поиск по тексту: PostgreSQL full-text + ILIKE + pg_trgm. Возвращает id + rank. */
async function textSearchIds(
  q: string,
  input: ListingQueryInput,
  whereBase: Prisma.ListingWhereInput,
  limit: number,
  cursor?: string
): Promise<{ rows: SearchRow[]; nextCursor: string | null; total: number }> {
  // Уважаем запрошенный статус. Дефолт ACTIVE — только для публичного
  // контекста (без sellerId); в кабинете продавца (sellerId задан, статуса
  // нет) полнотекстовый поиск идёт по всем статусам, как и обычный where.
  const ALL_STATUSES = ['PENDING', 'ACTIVE', 'RESERVED', 'SOLD', 'REJECTED', 'ARCHIVED'];
  const statuses = input.status ? [input.status] : input.sellerId ? ALL_STATUSES : ['ACTIVE'];
  const conditions: Prisma.Sql[] = [
    Prisma.sql`("Listing"."status"::text IN (${Prisma.join(statuses.map((s) => Prisma.sql`${s}`), ', ')}))`,
    Prisma.sql`(
      "Listing"."searchTs" @@ plainto_tsquery('simple', ${q})
      OR "Listing"."title" ILIKE ${'%' + q + '%'}
      OR "Listing"."description" ILIKE ${'%' + q + '%'}
    )`,
  ];
  if (input.category) {
    conditions.push(
      Prisma.sql`("Listing"."categoryId" = ${input.category} OR "Listing"."categoryId" IN (SELECT id FROM "Category" WHERE "parentId" = ${input.category}))`
    );
  }
  if (whereBase.city) conditions.push(Prisma.sql`"Listing"."city" = ${whereBase.city}`);
  if (whereBase.sellerId) conditions.push(Prisma.sql`"Listing"."sellerId" = ${whereBase.sellerId}`);
  const price = whereBase.price as Prisma.DecimalFilter | undefined;
  if (price?.gte !== undefined) conditions.push(Prisma.sql`"Listing"."price" >= ${price.gte}`);
  if (price?.lte !== undefined) conditions.push(Prisma.sql`"Listing"."price" <= ${price.lte}`);
  if (whereBase.favoritedBy) {
    const fav = whereBase.favoritedBy as { some: { userId: string } };
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "Favorite" f WHERE f."listingId" = "Listing".id AND f."userId" = ${fav.some.userId})`);
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

  const totalRow = await prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*)::bigint AS count FROM "Listing" ${whereSql}`;
  const total = Number(totalRow[0]?.count ?? 0);

  let cursorCond: Prisma.Sql = Prisma.empty;
  if (cursor) {
    const { primary, id } = decodeCursor(cursor);
    const rank = typeof primary === 'number' ? primary : NaN;
    if (!Number.isNaN(rank)) {
      // rank — алиас из SELECT, в WHERE его нельзя использовать напрямую,
      // поэтому фильтруем во внешнем запросе (см. ranked ниже).
      cursorCond = Prisma.sql`WHERE (rank < ${rank} OR (rank = ${rank} AND id < ${id}))`;
    }
  }

  const take = Math.min(limit ?? CURSOR_PAGE_SIZE, 50) + 1;
  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT id, rank FROM (
      SELECT "Listing".id AS id, ts_rank_cd(coalesce("Listing"."searchTs", to_tsvector('simple', '')), plainto_tsquery('simple', ${q})) AS rank
      FROM "Listing"
      ${whereSql}
    ) AS ranked
    ${cursorCond}
    ORDER BY rank DESC, id DESC
    LIMIT ${take}
  `;

  const hasMore = rows.length > take - 1;
  const pageRows = rows.slice(0, take - 1);
  const nextCursor = pageRows.length > 0 && hasMore ? encodeCursor(pageRows[pageRows.length - 1].rank, pageRows[pageRows.length - 1].id) : null;
  return { rows: pageRows, nextCursor, total };
}

export async function searchListings(input: ListingQueryInput, viewerId?: string) {
  const limit = Math.min(input.limit ?? CURSOR_PAGE_SIZE, 50);
  const where = buildWhere(input);
  const sort = sortOptions(input.sort);

  if (input.q && input.sort === 'relevance') {
    const { rows, nextCursor, total } = await textSearchIds(input.q, input, where, limit, input.cursor);
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) {
      return { items: [], nextCursor, total };
    }
    const listings = await prisma.listing.findMany({
      where: { id: { in: ids } },
      include: listingInclude,
    });
    const byId = new Map(listings.map((l) => [l.id, l]));
    const items = ids.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l));
    const favorites = viewerId ? await favoriteSet(viewerId, ids) : new Set<string>();
    return {
      items: items.map((l) => serializeListing(l, favorites)),
      nextCursor,
      total,
    };
  }

  const { field, dir } = sort;
  const orderBy = [{ [field]: dir }, { id: dir }] as Prisma.ListingOrderByWithRelationInput[];

  let cursorWhere: Prisma.ListingWhereInput = where;
  if (input.cursor) {
    const { primary, id } = decodeCursor(input.cursor);
    const op = dir === 'asc' ? 'gt' : 'lt';
    const fieldCond: Record<string, unknown> = {};
    if (field === 'price') {
      fieldCond[dir === 'asc' ? 'gt' : 'lt'] = primary as number;
    } else {
      fieldCond[op] = primary instanceof Date ? primary : new Date(primary);
    }
    cursorWhere = {
      AND: [
        where,
        {
          OR: [
            { [field]: fieldCond as never },
            { AND: [{ [field]: { equals: primary as never } }, { id: { [op]: id } }] },
          ],
        },
      ],
    };
  }

  const [items, total] = await Promise.all([
    prisma.listing.findMany({
      where: cursorWhere,
      orderBy,
      take: limit + 1,
      include: listingInclude,
    }),
    prisma.listing.count({ where }),
  ]);

  const hasMore = items.length > limit;
  const pageItems = items.slice(0, limit);
  const last = pageItems[pageItems.length - 1];
  const nextCursor = hasMore && last ? encodeCursor((last as Record<string, unknown>)[field] as Date | number, last.id) : null;

  const ids = pageItems.map((l) => l.id);
  const favorites = viewerId ? await favoriteSet(viewerId, ids) : new Set<string>();

  const serialized = pageItems.map((l) => serializeListing(l, favorites));

  return { items: serialized, nextCursor, total };
}

async function favoriteSet(userId: string, listingIds: string[]): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();
  const favs = await prisma.favorite.findMany({
    where: { userId, listingId: { in: listingIds } },
    select: { listingId: true },
  });
  return new Set(favs.map((f) => f.listingId));
}

function serializeListing(
  listing: Prisma.ListingGetPayload<{ include: typeof listingInclude }>,
  favorites: Set<string>
) {
  const { seller, ...rest } = listing;
  return {
    ...rest,
    price: Number(rest.price),
    viewsCount: Number(rest.viewsCount),
    isFavorite: favorites.has(listing.id),
    seller: {
      ...seller,
      rating: Number(seller.rating),
    },
  };
}

export function listingByIdInclude(favorites = new Set<string>()) {
  return {
    images: { orderBy: { position: 'asc' as const } },
    seller: {
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        city: true,
        rating: true,
        ratingCount: true,
        isVerified: true,
        createdAt: true,
      },
    },
    category: {
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        attributes: { orderBy: { sortOrder: 'asc' as const } },
      },
    },
    favoritedBy: true,
  };
}

/**
 * Счётчик просмотров с защитой от накрутки:
 * идемпотентность по user/IP + временное окно (24ч), без блокирующих очередей.
 */
export async function recordView(listingId: string, viewerId?: string, ip?: string): Promise<void> {
  const redis = getRedis();
  const identity = viewerId ?? `ip:${ip ?? 'unknown'}`;
  const dedupeKey = `view:${listingId}:${identity}`;
  const isNew = await redis.set(dedupeKey, '1', 'EX', 86400, 'NX');
  if (isNew === 'OK') {
    await prisma.listing.update({
      where: { id: listingId },
      data: { viewsCount: { increment: 1 } },
    });
    if (viewerId) {
      await prisma.viewedListing.upsert({
        where: { userId_listingId: { userId: viewerId, listingId } },
        update: { viewedAt: new Date() },
        create: { userId: viewerId, listingId },
      });
    }
  }
}

export async function getListingById(listingId: string, viewerId?: string, ip?: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: listingByIdInclude(),
  });
  if (!listing) {
    throw new AppError(errorCodes.NOT_FOUND, 'Объявление не найдено', 404);
  }
  await recordView(listingId, viewerId, ip);

  const isFavorite = viewerId
    ? (await prisma.favorite.findUnique({
        where: { userId_listingId: { userId: viewerId, listingId } },
      })) !== null
    : false;

  const similar = await prisma.listing.findMany({
    where: {
      categoryId: listing.categoryId,
      id: { not: listingId },
      status: 'ACTIVE',
    },
    take: 6,
    orderBy: { createdAt: 'desc' },
    include: {
      images: { take: 1, orderBy: { position: 'asc' as const } },
    },
  });

  const { favoritedBy, ...rest } = listing;
  return {
    ...rest,
    price: Number(rest.price),
    viewsCount: Number(rest.viewsCount),
    isFavorite,
    favoritedBy: undefined,
    seller: { ...listing.seller, rating: Number(listing.seller.rating) },
    similar: similar.map((s) => ({
      id: s.id,
      title: s.title,
      price: Number(s.price),
      currency: s.currency,
      city: s.city,
      viewsCount: Number(s.viewsCount),
      images: s.images,
      createdAt: s.createdAt,
    })),
  };
}
