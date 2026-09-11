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
    name: 'Услуги',
    slug: 'services',
    attributes: [{ key: 'priceType', label: 'Оплата', type: 'SELECT', options: ['За час', 'За работу'] }],
    children: [],
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

  for (const cat of categories) {
    const parent = await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: { name: cat.name, slug: cat.slug },
    });
    for (const attr of cat.attributes) {
      await prisma.categoryAttribute.upsert({
        where: { categoryId_key: { categoryId: parent.id, key: attr.key } },
        update: {},
        create: { categoryId: parent.id, ...attr },
      });
    }
    for (const child of cat.children) {
      const c = await prisma.category.upsert({
        where: { slug: child.slug },
        update: {},
        create: { name: child.name, slug: child.slug, parentId: parent.id },
      });
      for (const attr of child.attributes) {
        await prisma.categoryAttribute.upsert({
          where: { categoryId_key: { categoryId: c.id, key: attr.key } },
          update: {},
          create: { categoryId: c.id, ...attr },
        });
      }
    }
  }

  console.log(`Seed done. admin=${admin.email} demo=${demo.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
