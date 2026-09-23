import { z } from 'zod';
import { MESSAGE_LENGTH_LIMIT } from '../constants.js';

export const conversationListSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const messagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createConversationSchema = z.object({
  listingId: z.string().cuid(),
});

export const sendMessageSchema = z
  .object({
    // conversationId может прийти из URL-параметра :id (REST) или из body (WS-легаси).
    // Поэтому поле опционально: роут подставляет params.id при отсутствии.
    conversationId: z.string().cuid().optional(),
    text: z
      .string()
      .trim()
      .max(MESSAGE_LENGTH_LIMIT, `Максимум ${MESSAGE_LENGTH_LIMIT} символов`)
      .optional()
      .default(''),
    // Ключ фото из S3 (presign scope=chat). Сообщение может быть только фото без текста.
    imageKey: z.string().min(1).max(500).optional(),
  })
  .refine((d) => d.text.trim().length > 0 || (d.imageKey?.length ?? 0) > 0, {
    message: 'Сообщение не может быть пустым',
    path: ['text'],
  });

export const editMessageSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Сообщение не может быть пустым')
    .max(MESSAGE_LENGTH_LIMIT, `Максимум ${MESSAGE_LENGTH_LIMIT} символов`),
});

export const markReadSchema = z.object({
  conversationId: z.string().cuid().optional(),
});

export const typingSchema = z.object({
  conversationId: z.string().cuid(),
  isTyping: z.boolean(),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
