import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@marketplace/db';
import { cleanupStalePendingOrdersJob, decidePendingOutcome } from '../src/stalePendingOrders.js';

const infra = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const describeDb = infra ? describe : describe.skip;

const unique = Date.now();

let sellerId = '';
let buyerId = '';
let categoryId = '';

beforeAll(async () => {
  const cat = await prisma.category.findFirst();
  categoryId = cat?.id ?? '';
  const seller = await prisma.user.create({
    data: { phone: `+7${unique.toString().slice(-9)}s`, name: 'StaleSeller', passwordHash: 'x' },
  });
  sellerId = seller.id;
  const buyer = await prisma.user.create({
    data: { phone: `+7${unique.toString().slice(-9)}b`, name: 'StaleBuyer', passwordHash: 'x' },
  });
  buyerId = buyer.id;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { buyerId } });
  await prisma.listing.deleteMany({ where: { sellerId } });
  await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
  await prisma.$disconnect();
});

describe('decidePendingOutcome (unit)', () => {
  it('классифицирует статусы платежа', () => {
    expect(decidePendingOutcome('authorized')).toBe('paid');
    expect(decidePendingOutcome('captured')).toBe('paid');
    expect(decidePendingOutcome('canceled')).toBe('canceled');
    expect(decidePendingOutcome('pending')).toBe('open');
    expect(decidePendingOutcome('refunded')).toBe('unknown');
    expect(decidePendingOutcome('unknown')).toBe('unknown');
  });
});

describeDb('cleanupStalePendingOrdersJob (integration)', () => {
  it('удаляет PENDING-заказ старше 60 минут и снимает RESERVED', async () => {
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        categoryId: categoryId || undefined,
        title: `Брошенный товар ${unique}`,
        description: 'Описание брошенного товара для джобы чистки',
        price: 100,
        city: 'Москва',
        status: 'RESERVED',
      },
    });
    const order = await prisma.order.create({
      data: {
        listingId: listing.id,
        buyerId,
        amount: 100,
        status: 'PENDING',
        createdAt: new Date(Date.now() - 2 * 3600_000),
      },
    });

    const result = await cleanupStalePendingOrdersJob();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const gone = await prisma.order.findUnique({ where: { id: order.id } });
    expect(gone).toBeNull();
    const freed = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(freed.status).toBe('ACTIVE');
  });

  it('не трогает свежий PENDING-заказ', async () => {
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        categoryId: categoryId || undefined,
        title: `Свежий товар ${unique}`,
        description: 'Описание свежего товара для джобы чистки',
        price: 100,
        city: 'Москва',
        status: 'RESERVED',
      },
    });
    const order = await prisma.order.create({
      data: { listingId: listing.id, buyerId, amount: 100, status: 'PENDING' },
    });

    await cleanupStalePendingOrdersJob();

    const kept = await prisma.order.findUnique({ where: { id: order.id } });
    expect(kept).not.toBeNull();
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.listing.delete({ where: { id: listing.id } });
  });
});
