import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

const categories = [
  {
    name: 'Электроника',
    slug: 'electronics',
    attributes: [
      { key: 'brand', label: 'Бренд', type: 'TEXT' },
      { key: 'condition', label: 'Состояние', type: 'SELECT', options: ['Новое', 'Б/у'] },
      { key: 'model', label: 'Модель', type: 'TEXT' },
    ],
    children: [
      { name: 'Смартфоны', slug: 'smartphones', attributes: [{ key: 'storage', label: 'Память', type: 'SELECT', options: ['64GB', '128GB', '256GB', '512GB'] }] },
      { name: 'Ноутбуки', slug: 'laptops', attributes: [{ key: 'ram', label: 'RAM', type: 'SELECT', options: ['8GB', '16GB', '32GB'] }] },
      { name: 'Фото и видео', slug: 'cameras', attributes: [] },
      { name: 'Телефоны', slug: 'phones', attributes: [], children: [{ name: 'Кнопочные', slug: 'feature-phones', attributes: [] }] },
      { name: 'Компьютеры', slug: 'computers', attributes: [], children: [{ name: 'Мониторы', slug: 'monitors', attributes: [] }] },
    ],
  },
  {
    name: 'Недвижимость',
    slug: 'realty',
    attributes: [
      { key: 'rooms', label: 'Комнат', type: 'NUMBER', min: 0, max: 20 },
      { key: 'area', label: 'Площадь, м²', type: 'NUMBER', min: 1, max: 10000, unit: 'м²' },
      { key: 'dealType', label: 'Тип сделки', type: 'SELECT', options: ['Продажа', 'Аренда'] },
    ],
    children: [
      { name: 'Квартиры', slug: 'apartments', attributes: [{ key: 'floor', label: 'Этаж', type: 'NUMBER', min: 0, max: 200 }] },
      { name: 'Дома', slug: 'houses', attributes: [] },
    ],
  },
  {
    name: 'Транспорт',
    slug: 'vehicles',
    attributes: [
      { key: 'year', label: 'Год выпуска', type: 'RANGE', min: 1950, max: 2026 },
      { key: 'mileage', label: 'Пробег, км', type: 'NUMBER', min: 0, max: 1000000, unit: 'км' },
      { key: 'fuel', label: 'Топливо', type: 'SELECT', options: ['Бензин', 'Дизель', 'Электро', 'Гибрид'] },
    ],
    children: [
      { name: 'Автомобили', slug: 'cars', attributes: [{ key: 'transmission', label: 'КПП', type: 'SELECT', options: ['Механика', 'Автомат'] }] },
      { name: 'Мотоциклы', slug: 'motorcycles', attributes: [] },
    ],
  },
  {
    name: 'Одежда',
    slug: 'clothes',
    attributes: [
      { key: 'size', label: 'Размер', type: 'SELECT', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
      { key: 'condition', label: 'Состояние', type: 'SELECT', options: ['Новое', 'Б/у'] },
    ],
    children: [],
  },
  {
    name: 'Транспорт',
    slug: 'transport',
    attributes: [],
    children: [
      { name: 'Автомобили', slug: 'cars', attributes: [], children: [] },
      { name: 'Мотоциклы', slug: 'motorcycles', attributes: [], children: [] },
    ],
  },
  {
    name: 'Услуги',
    slug: 'services',
    attributes: [{ key: 'priceType', label: 'Оплата', type: 'SELECT', options: ['За час', 'За работу'] }],
    children: [],
  },
  {
    name: 'Работа',
    slug: 'jobs',
    attributes: [],
    children: [],
  },
];

// Стартовые локации: регион → города (идемпотентно через upsert).
const regions = [
  {
    name: 'Краснодарский край',
    slug: 'krasnodar',
    cities: [
      { name: 'Приморско-Ахтарск', slug: 'primorsko-ahtarsk' },
      { name: 'Краснодар', slug: 'krasnodar-city' },
      { name: 'Сочи', slug: 'sochi' },
      { name: 'Новороссийск', slug: 'novorossiysk' },
    ],
  },
  {
    name: 'Ростовская область',
    slug: 'rostov',
    cities: [
      { name: 'Ростов-на-Дону', slug: 'rostov-on-don' },
      { name: 'Таганрог', slug: 'taganrog' },
    ],
  },
  {
    name: 'Москва',
    slug: 'moscow',
    cities: [{ name: 'Москва', slug: 'moscow-city' }],
  },
  {
    name: 'Московская область',
    slug: 'mosobl',
    cities: [
      { name: 'Балашиха', slug: 'balashiha' },
      { name: 'Химки', slug: 'himki' },
    ],
  },
  {
    name: 'Санкт-Петербург',
    slug: 'spb',
    cities: [{ name: 'Санкт-Петербург', slug: 'spb-city' }],
  },
];

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: 'admin@marketplace.local' },
    update: {},
create: {
        email: 'admin@marketplace.local',
        phone: '+79990000001',
        name: 'Администратор',
        passwordHash: await argon2.hash('Admin123!', { type: argon2.argon2id }),
        role: 'ADMIN',
        isVerified: true,
        phoneVerifiedAt: new Date(),
      },
  });

  const demo = await prisma.user.upsert({
    where: { email: 'demo@marketplace.local' },
    update: {},
    create: {
      email: 'demo@marketplace.local',
      name: 'Демо-продавец',
      phone: '+79990001122',
      city: 'Москва',
      passwordHash: await argon2.hash('Demo123!', { type: argon2.argon2id }),
      isVerified: true,
      phoneVerifiedAt: new Date(),
    },
  });

  // Рекурсивный сид дерева (идемпотентно): существующие slug не трогаем,
  // чтобы не ломать объявления и тесты, завязанные на старые категории.
  async function seedCategory(
    node: { name: string; slug: string; attributes: any[]; children?: any[] },
    parentId: string | null
  ): Promise<string> {
    const c = await prisma.category.upsert({
      where: { slug: node.slug },
      update: {},
      create: { name: node.name, slug: node.slug, parentId },
    });
    for (const attr of node.attributes) {
      await prisma.categoryAttribute.upsert({
        where: { categoryId_key: { categoryId: c.id, key: attr.key } },
        update: {},
        create: { categoryId: c.id, ...attr },
      });
    }
    for (const child of node.children ?? []) {
      await seedCategory(child, c.id);
    }
    return c.id;
  }

  for (const cat of categories) {
    await seedCategory(cat, null);
  }

  console.log(`Seed done. admin=${admin.email} demo=${demo.email}`);

  for (const region of regions) {
    const r = await prisma.region.upsert({
      where: { slug: region.slug },
      update: {},
      create: { name: region.name, slug: region.slug },
    });
    for (const city of region.cities) {
      await prisma.city.upsert({
        where: { regionId_slug: { regionId: r.id, slug: city.slug } },
        update: {},
        create: { name: city.name, slug: city.slug, regionId: r.id },
      });
    }
  }
  console.log(`Seed regions done: ${regions.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
