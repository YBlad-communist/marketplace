import { Router } from 'express';
import { prisma } from '@marketplace/db';

const router: Router = Router();

// GET /api/regions — регионы с городами внутри (публично — только активные).
router.get('/regions', async (req, res, next) => {
  try {
    const onlyActive = req.query.all !== '1';
    const regions = await prisma.region.findMany({
      where: onlyActive ? { isActive: true } : {},
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        cities: {
          where: onlyActive ? { isActive: true } : {},
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
    });
    res.json({ data: { regions } });
  } catch (err) {
    next(err);
  }
});

// GET /api/regions/:slug/cities — города одного региона.
router.get('/regions/:slug/cities', async (req, res, next) => {
  try {
    const region = await prisma.region.findUnique({ where: { slug: req.params.slug } });
    if (!region) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Регион не найден' } });
    }
    const cities = await prisma.city.findMany({
      where: { regionId: region.id, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { region: { select: { id: true, name: true, slug: true } } },
    });
    res.json({ data: { region, cities } });
  } catch (err) {
    next(err);
  }
});

export default router;
