import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@marketplace/db';

const retrieveMock = vi.hoisted(() =>
  vi.fn(async (id: string) => ({ id, status: 'canceled' }))
);

vi.mock('stripe', () => ({
  __esModule: true,
  default: class {
    paymentIntents = { retrieve: retrieveMock };
  },
}));

import { checkExpiredHoldsJob } from '../src/expiredHolds.js';

async function isInfraAvailable(): Promise<boolean> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const unique = Date.now();
const phone = (n: number) => `+7${unique.toString().slice(-9)}${n}`;

let raceOrderId = '';

async function createStalePaidOrder(tag: string, piId: string): Promise<{ orderId: string; listingId: string }> {
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  const seller = await prisma.user.upsert({
    where: { phone: phone(8) },
    update: {},
    create: { phone: phone(8), name: 'Продавец-холд' },
  });
  const buyer = await prisma.user.upsert({
    where: { phone: phone(9) },
    update: {},
    create: { phone: phone(9), name: 'Покупатель-холд' },
  });

  const listing = await prisma.listing.create({
    data: {
      title: `Холд-объявление ${tag}`,
      description: 'Описание объявления для теста проверки холдов',
      price: 100,
      currency: 'EUR',
      status: 'RESERVED',
      sellerId: seller.id,
      categoryId: cat?.id ?? '',
      city: 'Москва',
    },
  });

  const order = await prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId: buyer.id,
      amount: 100,
      currency: 'EUR',
      status: 'PAID',
      stripePaymentIntentId: piId,
      createdAt: new Date(Date.now() - 8 * 86400_000),
    },
  });
  return { orderId: order.id, listingId: listing.id };
}

beforeAll(async () => {
  await prisma.$connect();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  if (cat) {
    // категория уже есть — ок
  } else {
    await prisma.category.upsert({
      where: { slug: 'services' },
      update: {},
      create: { name: 'Услуги', slug: 'services' },
    });
    await prisma.category.upsert({
      where: { slug: 'electronics' },
      update: {},
      create: { name: 'Электроника', slug: 'electronics' },
    });
  }
});

afterAll(async () => {
  retrieveMock.mockRestore?.();
  await prisma.$disconnect();
});

describeInfra('expired holds job: атомарный клейм не перетирает начатую выплату', () => {
  it('истёкший PAID-холд возвращается (REFUNDED + объявление ACTIVE)', async () => {
    const { orderId, listingId } = await createStalePaidOrder('claim', `pi_hold_${unique}_claim`);

    const result = await checkExpiredHoldsJob();

    expect(result.refunded).toBeGreaterThanOrEqual(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('REFUNDED');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('ACTIVE');
  });

  it('гонка с releaseOrder: джоба НЕ перезаписывает заказ, ушедший в RELEASING между чтением и записью', async () => {
    const { orderId, listingId } = await createStalePaidOrder('race', `pi_hold_${unique}_race`);
    raceOrderId = orderId;

    // Имитация гонки: джоба уже прочитала PAID-заказ и спрашивает Stripe,
    // а покупатель в этот момент успел запустить releaseOrder (PAID -> RELEASING).
    retrieveMock.mockImplementation(async (id: string) => {
      if (id === `pi_hold_${unique}_race`) {
        await prisma.order.update({
          where: { id: raceOrderId },
          data: { status: 'RELEASING' },
        });
      }
      return { id, status: 'canceled' };
    });

    const result = await checkExpiredHoldsJob();
    retrieveMock.mockImplementation(async (id: string) => ({ id, status: 'canceled' }));

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASING');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('RESERVED');
    expect(result.refunded).toBe(0);
  });
});