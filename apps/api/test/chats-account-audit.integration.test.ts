import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { ListingStatus, prisma } from '@marketplace/db';
import { createApp } from '../src/app.js';
import { connectRedis, disconnectRedis } from '../src/lib/redis.js';
import { isInfraAvailable } from './helpers.js';
import { deleteConversation, listConversations, editMessage } from '../src/services/conversationService.js';
import { deleteAccount } from '../src/services/accountService.js';

vi.mock('../src/services/notificationService.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/notificationService.js')>();
  return { ...mod, enqueueSms: vi.fn(async () => undefined), enqueueS3Delete: vi.fn(async () => undefined) };
});

const app = createApp();
const password = 'Strong123!';
const unique = Date.now();

const infra = await isInfraAvailable();
const describeInfra = infra ? describe : describe.skip;

const DELETED_USER_ID = '__system_deleted__';

function phone(n: string): string {
  return `+7${unique.toString().slice(-8)}${n}`;
}

async function createUserRow(p: string, name = 'Тест') {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
  return prisma.user.create({ data: { name, phone: p, passwordHash } });
}

async function createListingRow(sellerId: string, title: string, status: ListingStatus = 'ACTIVE') {
  const cat = await prisma.category.findFirstOrThrow({ where: { slug: 'services' } });
  return prisma.listing.create({
    data: { title, description: `Описание: ${title}`, price: 100, categoryId: cat.id, city: 'Казань', sellerId, status },
  });
}

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  await disconnectRedis();
});

describeInfra('п.30: мягкое скрытие чата, hard delete только когда скрыли оба', () => {
  it('первое удаление скрывает чат у инициатора, второй участник его видит', async () => {
    const a = await createUserRow(phone('301'), 'Участник A');
    const b = await createUserRow(phone('302'), 'Участник B');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } },
    });
    await prisma.message.create({ data: { conversationId: conv.id, senderId: a.id, text: 'Привет' } });

    const soft = await deleteConversation(conv.id, a.id);
    expect(soft.hardDeleted).toBe(false);

    // Чат существует и виден B, скрыт для A.
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).not.toBeNull();
    const listA = await listConversations(a.id);
    expect(listA.items.some((c) => c.id === conv.id)).toBe(false);
    const listB = await listConversations(b.id);
    expect(listB.items.some((c) => c.id === conv.id)).toBe(true);

    // Повторное удаление A (уже скрыт) — по-прежнему мягкое, пока B не скрыл.
    const again = await deleteConversation(conv.id, a.id);
    expect(again.hardDeleted).toBe(false);

    // B скрывает — hard delete.
    const hard = await deleteConversation(conv.id, b.id);
    expect(hard.hardDeleted).toBe(true);
    expect(hard.participantIds.sort()).toEqual([a.id, b.id].sort());
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).toBeNull();
    expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  it('REST DELETE возвращает hardDeleted и удаляет чат только когда скрыли оба', async () => {
    const a = await createUserRow(phone('303'), 'REST A');
    const b = await createUserRow(phone('304'), 'REST B');
    const loginA = await request(app).post('/api/auth/login').send({ phone: a.phone, password });
    const loginB = await request(app).post('/api/auth/login').send({ phone: b.phone, password });
    const tokenA = loginA.body.data.accessToken;
    const tokenB = loginB.body.data.accessToken;
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } },
    });

    const del1 = await request(app)
      .delete(`/api/conversations/${conv.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(del1.status).toBe(200);
    expect(del1.body.data.hardDeleted).toBe(false);

    const del2 = await request(app)
      .delete(`/api/conversations/${conv.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(del2.status).toBe(200);
    expect(del2.body.data.hardDeleted).toBe(true);
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).toBeNull();
  });

  it('удаление чата, привязанного к объявлению с активным заказом, запрещено (409)', async () => {
    const seller = await createUserRow(phone('305'), 'Продавец');
    const buyer = await createUserRow(phone('306'), 'Покупатель');
    const listing = await createListingRow(seller.id, 'Активная сделка в чате');
    // Активный заказ PENDING блокирует удаление чата по объявлению.
    const order = await prisma.order.create({
      data: { listingId: listing.id, buyerId: buyer.id, amount: 100, status: 'PENDING' },
    });
    const conv = await prisma.conversation.create({
      data: { listingId: listing.id, participants: { create: [{ userId: buyer.id }, { userId: seller.id }] } },
    });

    await expect(deleteConversation(conv.id, buyer.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).not.toBeNull();

    // Заказ стал терминальным — удаление разрешено.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'RELEASED' } });
    const ok = await deleteConversation(conv.id, buyer.id);
    expect(ok.hardDeleted).toBe(false);
  });

  it('чат без привязки к сделке удаляется мягко даже при заказах у других объявлений', async () => {
    const a = await createUserRow(phone('307'), 'Свободный A');
    const b = await createUserRow(phone('308'), 'Свободный B');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } },
    });
    const soft = await deleteConversation(conv.id, a.id);
    expect(soft.hardDeleted).toBe(false);
    await deleteConversation(conv.id, b.id);
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).toBeNull();
  });
});

describeInfra('п.31: история правок сообщения и окно 15 минут', () => {
  it('правка фиксирует оригинальный текст и ставит isEdited; повторные правки сохраняют первый оригинал', async () => {
    const a = await createUserRow(phone('311'), 'Редактор');
    const b = await createUserRow(phone('312'), 'Читатель');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } },
    });
    const msg = await prisma.message.create({
      data: { conversationId: conv.id, senderId: a.id, text: 'Исходный текст' },
    });

    const first = await editMessage(conv.id, msg.id, a.id, 'Первая правка');
    expect(first.text).toBe('Первая правка');
    expect(first.originalText).toBe('Исходный текст');
    expect(first.editedAt).toBeTruthy();
    expect(first.isEdited).toBe(true);

    const second = await editMessage(conv.id, msg.id, a.id, 'Вторая правка');
    expect(second.originalText).toBe('Исходный текст');

    const stored = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
    expect(stored.originalText).toBe('Исходный текст');
    expect(stored.text).toBe('Вторая правка');
  });

  it('правка старше 15 минут запрещена (409)', async () => {
    const a = await createUserRow(phone('313'), 'Опоздавший');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: a.id }] } },
    });
    const msg = await prisma.message.create({
      data: { conversationId: conv.id, senderId: a.id, text: 'Старое сообщение' },
    });
    // Сообщение «отправлено» 16 минут назад.
    await prisma.message.update({
      where: { id: msg.id },
      data: { createdAt: new Date(Date.now() - 16 * 60 * 1000) },
    });

    await expect(editMessage(conv.id, msg.id, a.id, 'Поздняя правка')).rejects.toMatchObject({
      statusCode: 409,
    });
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
    expect(stored.text).toBe('Старое сообщение');
    expect(stored.editedAt).toBeNull();
  });

  it('пограничное: правка ровно в окне (14 минут) проходит', async () => {
    const a = await createUserRow(phone('314'), 'Пограничный');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: a.id }] } },
    });
    const msg = await prisma.message.create({
      data: { conversationId: conv.id, senderId: a.id, text: 'В окне' },
    });
    await prisma.message.update({
      where: { id: msg.id },
      data: { createdAt: new Date(Date.now() - 14 * 60 * 1000) },
    });
    const edited = await editMessage(conv.id, msg.id, a.id, 'В окне (правка)');
    expect(edited.text).toBe('В окне (правка)');
  });
});

describeInfra('п.32: удаление аккаунта анонимизирует заказы и отзывы вместо удаления', () => {
  it('заказы RELEASED/REFUNDED сохраняются с buyerId=sentinel, пользователь удалён', async () => {
    const seller = await createUserRow(phone('321'), 'Продавец-32');
    const buyer = await createUserRow(phone('322'), 'Покупатель-32');
    const listing = await createListingRow(seller.id, 'Продано и выплачено');
    const released = await prisma.order.create({
      data: { listingId: listing.id, buyerId: buyer.id, amount: 500, status: 'RELEASED', releasedAt: new Date() },
    });
    const refunded = await prisma.order.create({
      data: { listingId: listing.id, buyerId: buyer.id, amount: 300, status: 'REFUNDED' },
    });

    await deleteAccount(buyer.id, password);

    expect(await prisma.user.findUnique({ where: { id: buyer.id } })).toBeNull();
    const o1 = await prisma.order.findUniqueOrThrow({ where: { id: released.id } });
    const o2 = await prisma.order.findUniqueOrThrow({ where: { id: refunded.id } });
    expect(o1.buyerId).toBe(DELETED_USER_ID);
    expect(o2.buyerId).toBe(DELETED_USER_ID);
    expect(o1.status).toBe('RELEASED');
    expect(o2.status).toBe('REFUNDED');
    expect(Number(o1.amount)).toBe(500);
  });

  it('отзывы других людей о пользователе сохраняются анонимизированными, свои удаляются', async () => {
    const reviewer = await createUserRow(phone('323'), 'Рецензент-32');
    const deleted = await createUserRow(phone('324'), 'Уходящий-32');
    const other = await createUserRow(phone('325'), 'Посторонний-32');
    const listing = await createListingRow(reviewer.id, 'Заказ для отзыва', 'SOLD');
    const order = await prisma.order.create({
      data: { listingId: listing.id, buyerId: deleted.id, amount: 100, status: 'RELEASED' },
    });
    // Отзыв покупателя (deleted) о продавце (reviewer) — свой, удаляется.
    const ownReview = await prisma.review.create({
      data: { authorId: deleted.id, revieweeId: reviewer.id, orderId: order.id, rating: 5, text: 'Отличный продавец' },
    });
    // Отзыв постороннего о deleted (сделочный) — сохраняется анонимизированным.
    const foreignReview = await prisma.review.create({
      data: { authorId: other.id, revieweeId: deleted.id, orderId: order.id, rating: 4, text: 'Приличный покупатель' },
    });
    // Свободный отзыв о deleted — сохраняется анонимизированным.
    const freeReview = await prisma.review.create({
      data: { authorId: other.id, revieweeId: deleted.id, rating: 3, text: 'Свободное впечатление' },
    });

    await deleteAccount(deleted.id, password);

    expect(await prisma.review.findUnique({ where: { id: ownReview.id } })).toBeNull();
    const keptOrderReview = await prisma.review.findUniqueOrThrow({ where: { id: foreignReview.id } });
    expect(keptOrderReview.revieweeId).toBe(DELETED_USER_ID);
    expect(keptOrderReview.text).toBe('Приличный покупатель');
    const keptFree = await prisma.review.findUniqueOrThrow({ where: { id: freeReview.id } });
    expect(keptFree.revieweeId).toBe(DELETED_USER_ID);
    expect(keptFree.rating).toBe(3);
    // Авторство настоящих людей сохранено.
    expect(keptOrderReview.authorId).toBe(other.id);
  });

  it('активный заказ блокирует удаление аккаунта (409), терминальный — нет', async () => {
    const seller = await createUserRow(phone('326'), 'Продавец-32b');
    const buyer = await createUserRow(phone('327'), 'Покупатель-32b');
    const listing = await createListingRow(seller.id, 'Активная сделка-32');
    const order = await prisma.order.create({
      data: { listingId: listing.id, buyerId: buyer.id, amount: 200, status: 'PENDING' },
    });

    await expect(deleteAccount(buyer.id, password)).rejects.toMatchObject({ statusCode: 409 });
    await expect(deleteAccount(seller.id, password)).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.user.findUnique({ where: { id: buyer.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: seller.id } })).not.toBeNull();

    await prisma.order.update({ where: { id: order.id }, data: { status: 'RELEASED' } });
    await deleteAccount(buyer.id, password);
    expect(await prisma.user.findUnique({ where: { id: buyer.id } })).toBeNull();
    // Заказ остался финансовой записью.
    expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull();
  });

  it('объявление с терминальным заказом анонимизируется, без заказов — удаляется', async () => {
    const seller = await createUserRow(phone('328'), 'Продавец-32c');
    const buyer = await createUserRow(phone('329'), 'Покупатель-32c');
    const withOrder = await createListingRow(seller.id, 'С заказом');
    const withoutOrder = await createListingRow(seller.id, 'Без заказов');
    await prisma.order.create({
      data: { listingId: withOrder.id, buyerId: buyer.id, amount: 100, status: 'REFUNDED' },
    });

    await deleteAccount(seller.id, password);

    const kept = await prisma.listing.findUniqueOrThrow({ where: { id: withOrder.id } });
    expect(kept.sellerId).toBe(DELETED_USER_ID);
    expect(kept.status).toBe('ARCHIVED');
    expect(await prisma.listing.findUnique({ where: { id: withoutOrder.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: seller.id } })).toBeNull();
  });

  it('чат второй стороны переживает удаление: сообщения уходят к sentinel, участник остаётся', async () => {
    const seller = await createUserRow(phone('32a'), 'Продавец-32d');
    const buyer = await createUserRow(phone('32b'), 'Покупатель-32d');
    const conv = await prisma.conversation.create({
      data: { participants: { create: [{ userId: seller.id }, { userId: buyer.id }] } },
    });
    const sellerMsg = await prisma.message.create({
      data: { conversationId: conv.id, senderId: seller.id, text: 'Сообщение продавца' },
    });
    const buyerMsg = await prisma.message.create({
      data: { conversationId: conv.id, senderId: buyer.id, text: 'Сообщение покупателя' },
    });

    await deleteAccount(seller.id, password);

    // Чат остался, участник-покупатель видит его в списке.
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).not.toBeNull();
    const list = await listConversations(buyer.id);
    expect(list.items.some((c) => c.id === conv.id)).toBe(true);
    // Сообщение продавца сохранено, автор анонимизирован.
    const kept = await prisma.message.findUniqueOrThrow({ where: { id: sellerMsg.id } });
    expect(kept.senderId).toBe(DELETED_USER_ID);
    expect(kept.text).toBe('Сообщение продавца');
    // Сообщение покупателя не тронуто.
    expect((await prisma.message.findUniqueOrThrow({ where: { id: buyerMsg.id } })).senderId).toBe(buyer.id);
    // Строки участников продавца нет.
    expect(
      await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: conv.id, userId: seller.id } },
      })
    ).toBeNull();
    // Список удалённого продавца недоступен (пользователь удалён).
    await expect(listConversations(seller.id)).resolves.toMatchObject({ items: [], total: 0 });
  });

  it('чужие listing-изображения не попадают в S3-очистку при наличии заказов', async () => {
    const seller = await createUserRow(phone('32c'), 'Продавец-32e');
    const buyer = await createUserRow(phone('32d'), 'Покупатель-32e');
    const listing = await createListingRow(seller.id, 'С фото и заказом');
    await prisma.listingImage.deleteMany({ where: { key: 'images/listing-32e.webp' } });
    await prisma.listingImage.create({
      data: { listingId: listing.id, url: 'https://cdn.test/x.webp', key: 'images/listing-32e.webp', position: 0 },
    });
    await prisma.order.create({
      data: { listingId: listing.id, buyerId: buyer.id, amount: 100, status: 'RELEASED' },
    });

    const { enqueueS3Delete } = await import('../src/services/notificationService.js');
    await deleteAccount(seller.id, password);
    // Фото оставленного объявления не удаляются из S3.
    expect(vi.mocked(enqueueS3Delete)).not.toHaveBeenCalledWith(
      expect.arrayContaining(['images/listing-32e.webp'])
    );
    // Строка изображения цела вместе с объявлением.
    expect(await prisma.listingImage.findFirst({ where: { key: 'images/listing-32e.webp' } })).not.toBeNull();
  });
});
