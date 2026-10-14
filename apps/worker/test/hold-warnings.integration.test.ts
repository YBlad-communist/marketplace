import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@marketplace/db';
import { HOLD_WARN_12H_MS, HOLD_WARN_2D_MS } from '@marketplace/shared';

import { checkHoldWarningsJob } from '../src/holdWarnings.js';

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

async function createHoldOrder(
  tag: string,
  status: 'PAID' | 'SHIPPED' | 'DISPUTED',
  holdExpiresAt: Date | null
): Promise<string> {
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  const seller = await prisma.user.upsert({
    where: { phone: phone(6) },
    update: {},
    create: { phone: phone(6), name: 'Продавец-предупреждения' },
  });
  const buyer = await prisma.user.upsert({
    where: { phone: phone(7) },
    update: {},
    create: { phone: phone(7), name: 'Покупатель-предупреждения' },
  });

  const listing = await prisma.listing.create({
    data: {
      title: `Предупреждение-тест ${tag}`,
      description: 'Описание объявления для теста предупреждений о холде',
      price: 100,
      currency: 'RUB',
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
      currency: 'RUB',
      status,
      yookassaPaymentId: `yoo_warn_${unique}_${tag}`,
      holdExpiresAt,
      holdWarned2dAt: null,
      holdWarned12hAt: null,
      createdAt: new Date(Date.now() - 86400_000),
    },
  });
  return order.id;
}

beforeAll(async () => {
  await prisma.$connect();
  // Чистим заказы прошлых прогонов: джоба берёт все заказы в окне предупреждения.
  await prisma.order.deleteMany({ where: { listing: { title: { startsWith: 'Предупреждение-тест' } } } });
  await prisma.listing.deleteMany({ where: { title: { startsWith: 'Предупреждение-тест' } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describeInfra('hold warnings job', () => {
  it('предупреждает за 2 дня и за 12 часов, флаги ставятся одноразово', async () => {
    const twoDaysId = await createHoldOrder('2d', 'PAID', new Date(Date.now() + 25 * 3_600_000));
    const twelveId = await createHoldOrder('12h', 'PAID', new Date(Date.now() + 1 * 3_600_000));
    expect(HOLD_WARN_2D_MS).toBe(2 * 86_400_000);
    expect(HOLD_WARN_12H_MS).toBe(12 * 3_600_000);

    const first = await checkHoldWarningsJob();
    expect(first.warned2d).toBeGreaterThanOrEqual(1);
    expect(first.warned12h).toBeGreaterThanOrEqual(1);

    const twoDays = await prisma.order.findUniqueOrThrow({ where: { id: twoDaysId } });
    expect(twoDays.holdWarned2dAt).not.toBeNull();
    // Ещё не в 12-часовом окне — эта метка не ставится.
    expect(twoDays.holdWarned12hAt).toBeNull();

    const twelveHours = await prisma.order.findUniqueOrThrow({ where: { id: twelveId } });
    expect(twelveHours.holdWarned2dAt).not.toBeNull();
    expect(twelveHours.holdWarned12hAt).not.toBeNull();

    // Второй прогон ничего не дублирует — клейм требует null-флаг.
    const second = await checkHoldWarningsJob();
    expect(second.warned2d).toBe(0);
    expect(second.warned12h).toBe(0);
  });

  it('SHIPPED тоже попадает в предупреждения', async () => {
    const shippedId = await createHoldOrder('shipped', 'SHIPPED', new Date(Date.now() + 2 * 3_600_000));
    await checkHoldWarningsJob();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: shippedId } });
    expect(order.holdWarned12hAt).not.toBeNull();
  });

  it('просроченные, без срока и DISPUTED заказы не предупреждаются', async () => {
    const pastId = await createHoldOrder('past', 'PAID', new Date(Date.now() - 3_600_000));
    const noTermId = await createHoldOrder('no-term', 'PAID', null);
    const disputedId = await createHoldOrder('disputed', 'DISPUTED', new Date(Date.now() + 3_600_000));

    await checkHoldWarningsJob();

    const orders = await prisma.order.findMany({ where: { id: { in: [pastId, noTermId, disputedId] } } });
    for (const order of orders) {
      expect(order.holdWarned2dAt).toBeNull();
      expect(order.holdWarned12hAt).toBeNull();
    }
  });
});
