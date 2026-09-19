import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@marketplace/db';

// Мок сети ЮKassa: GET /payments/{id} отдаёт статус. Мок на уровне fetch,
// поэтому логика джобы (клейм, разбор статусов) остаётся настоящей.
type PaymentStatusFn = (paymentId: string) => string | Promise<string>;
let statusFor: PaymentStatusFn = () => 'canceled';
let captureStatuses = new Map<string, string>();

const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input.toString();
  const match = url.match(/\/payments\/([^/?]+)/);
  const id = match ? match[1] : '';
  const status = captureStatuses.get(id) ?? (await statusFor(id));
  return new Response(JSON.stringify({ id, status }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
vi.stubGlobal('fetch', fetchMock);

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

async function createStalePaidOrder(tag: string, paymentId: string): Promise<{ orderId: string; listingId: string }> {
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
      status: 'PAID',
      yookassaPaymentId: paymentId,
      createdAt: new Date(Date.now() - 8 * 86400_000),
    },
  });
  return { orderId: order.id, listingId: listing.id };
}

beforeAll(async () => {
  await prisma.$connect();
  const cat = await prisma.category.findFirst({ where: { slug: 'electronics' } });
  if (!cat) {
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
  // Чистим холд-заказы прошлых прогонов: джоба берёт все просроченные PAID
  // заказы, поэтому оставленный «живой холд» искажал бы счётчик refunded.
  await prisma.order.deleteMany({ where: { listing: { title: { startsWith: 'Холд-объявление' } } } });
  await prisma.listing.deleteMany({ where: { title: { startsWith: 'Холд-объявление' } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describeInfra('expired holds job: атомарный клейм не перетирает начатую выплату', () => {
  it('истёкший PAID-холд возвращается (REFUNDED + объявление ACTIVE)', async () => {
    const { orderId, listingId } = await createStalePaidOrder('claim', `yoo_hold_${unique}_claim`);

    const result = await checkExpiredHoldsJob();

    expect(result.refunded).toBeGreaterThanOrEqual(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('REFUNDED');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('ACTIVE');
  });

  it('живой холд (waiting_for_capture) не закрывается', async () => {
    const paymentId = `yoo_hold_${unique}_alive`;
    const { orderId } = await createStalePaidOrder('alive', paymentId);
    captureStatuses = new Map([[paymentId, 'waiting_for_capture']]);

    const result = await checkExpiredHoldsJob();
    captureStatuses = new Map();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');
    expect(result.refunded).toBe(0);

    // «Омолаживаем» холд, чтобы он не попал в следующий прогон джобы
    // и не искажал счётчик refunded в тесте гонки.
    await prisma.order.update({ where: { id: orderId }, data: { createdAt: new Date() } });
  });

  it('гонка с releaseOrder: джоба НЕ перезаписывает заказ, ушедший в RELEASING между чтением и записью', async () => {
    const paymentId = `yoo_hold_${unique}_race`;
    const { orderId, listingId } = await createStalePaidOrder('race', paymentId);
    raceOrderId = orderId;

    // Имитация гонки: джоба уже прочитала PAID-заказ и спрашивает ЮKassa,
    // а покупатель в этот момент успел запустить releaseOrder (PAID -> RELEASING).
    statusFor = async (id: string) => {
      if (id === paymentId) {
        await prisma.order.update({ where: { id: raceOrderId }, data: { status: 'RELEASING' } });
      }
      return 'canceled';
    };

    const result = await checkExpiredHoldsJob();
    statusFor = () => 'canceled';

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('RELEASING');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('RESERVED');
    expect(result.refunded).toBe(0);
  });
});
