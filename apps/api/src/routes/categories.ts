import { Router } from 'express';
import { prisma } from '@marketplace/db';

const router: Router = Router();

const attrOrder = { orderBy: { sortOrder: 'asc' as const } };

type FlatCategory = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  attributes: { id: string; key: string; label: string; type: string; unit: string | null; required: boolean; options: unknown; min: number | null; max: number | null }[];
};

/** Плоский список → вложенное дерево (глубина не ограничена). */
function buildTree(rows: FlatCategory[]) {
  const byId = new Map<string, FlatCategory & { children: unknown[] }>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: (FlatCategory & { children: unknown[] })[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      (byId.get(node.parentId)!.children as unknown[]).push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (list: (FlatCategory & { children: unknown[] })[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'));
    for (const n of list) sortNodes(n.children as (FlatCategory & { children: unknown[] })[]);
  };
  sortNodes(roots);
  return roots;
}

router.get('/', async (req, res, next) => {
  try {
    // Публично — только активные; админка передаёт ?all=1 и видит всё.
    const onlyActive = req.query.all !== '1';
    const categories = await prisma.category.findMany({
      where: onlyActive ? { isActive: true } : {},
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        icon: true,
        parentId: true,
        sortOrder: true,
        isActive: true,
        attributes: { orderBy: { sortOrder: 'asc' } },
      },
    });
    res.json({ data: { categories: buildTree(categories as FlatCategory[]) } });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({
      where: { slug: req.params.slug },
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        children: { orderBy: { sortOrder: 'asc' } },
        attributes: attrOrder,
      },
    });
    if (!category) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Категория не найдена' } });
    }
    // Объявления категории с пагинацией (только активные).
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    const listings = await prisma.listing.findMany({
      where: { categoryId: category.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      cursor: req.query.cursor ? { id: String(req.query.cursor) } : undefined,
      skip: req.query.cursor ? 1 : 0,
      select: {
        id: true,
        title: true,
        price: true,
        city: true,
        createdAt: true,
        images: { take: 1, orderBy: { position: 'asc' as const } },
      },
    });
    const hasMore = listings.length > limit;
    const items = listings.slice(0, limit);
    res.json({
      data: {
        category,
        listings: { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null },
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
