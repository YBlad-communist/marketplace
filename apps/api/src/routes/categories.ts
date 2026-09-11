import { Router } from 'express';
import { prisma } from '@marketplace/db';

const router: Router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      where: { parentId: null },
      orderBy: { sortOrder: 'asc' },
      include: {
        children: {
          orderBy: { sortOrder: 'asc' },
          include: { attributes: { orderBy: { sortOrder: 'asc' } } },
        },
        attributes: { orderBy: { sortOrder: 'asc' } },
      },
    });
    res.json({ data: { categories } });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({
      where: { slug: req.params.slug },
      include: {
        parent: true,
        children: { orderBy: { sortOrder: 'asc' } },
        attributes: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!category) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Категория не найдена' } });
    }
    res.json({ data: { category } });
  } catch (err) {
    next(err);
  }
});

export default router;
