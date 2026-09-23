import { z } from 'zod';
import { normalizePhone } from './auth.js';

export const createOrderSchema = z.object({
  listingId: z.string().cuid(),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9._-]+$/),
});

export const sellerYookassaConnectSchema = z.object({
  shopId: z.string().trim().min(1, 'Укажите Shop ID магазина ЮKassa').max(64),
});

export const reviewCreateSchema = z.object({
  revieweeId: z.string().cuid(),
  // Отзыв возможен только по завершённой сделке: revieweeId обязан совпадать
  // с контрагентом из заказа (проверяется в хендлере), иначе это накрутка.
  orderId: z.string().cuid(),
  rating: z.number().int().min(1).max(5),
  text: z.string().trim().min(1).max(2000).optional(),
});

export const reportCreateSchema = z.object({
  targetType: z.enum(['LISTING', 'USER', 'MESSAGE']),
  targetId: z.string().cuid(),
  reason: z.enum([
    'SPAM',
    'FRAUD',
    'INAPPROPRIATE',
    'COPYRIGHT',
    'DUPLICATE',
    'PROHIBITED',
    'OTHER',
  ]),
  comment: z.string().trim().min(1).max(3000).optional(),
});

export const adminModerationSchema = z.object({
  // listingId дублируется в URL (:id) и body (легаси web-клиент). Делаем опциональным,
  // роут берёт params.id как источник истины.
  listingId: z.string().cuid().optional(),
  action: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(1000).optional(),
});

export const adminBanSchema = z.object({
  // userId дублируется в URL (:id) и body. Опционально по той же причине.
  userId: z.string().cuid().optional(),
  banned: z.boolean(),
  reason: z.string().trim().max(1000).optional(),
});

export const reviewQuerySchema = z.object({
  userId: z.string().cuid(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const avatarConfirmSchema = z.object({
  key: z.string().min(1).max(500),
});

export const usersMeUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\+?[0-9\s\-()]{7,20}$/.test(v), 'Некорректный телефон')
      .transform((v) => (v === '' ? '' : normalizePhone(v)))
      .optional(),
    city: z.string().trim().max(120).optional().or(z.literal('')),
    avatarUrl: z.string().url().max(500).optional().or(z.literal('')),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Нет полей для обновления' });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ReviewCreateInput = z.infer<typeof reviewCreateSchema>;
export type ReportCreateInput = z.infer<typeof reportCreateSchema>;
export type UsersMeUpdateInput = z.infer<typeof usersMeUpdateSchema>;
export type AvatarConfirmInput = z.infer<typeof avatarConfirmSchema>;
