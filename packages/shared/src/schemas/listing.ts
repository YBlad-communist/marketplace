import { z } from 'zod';
import { ALLOWED_IMAGE_EXT, ALLOWED_IMAGE_MIME, LISTING_IMAGE_LIMIT } from '../constants.js';
const citySchema = z.string().trim().min(1).max(120);
const titleSchema = z.string().trim().min(3).max(200);
const descriptionSchema = z.string().trim().min(10).max(10000);
const priceSchema = z.number().min(0.01, 'Цена должна быть больше 0').max(1_000_000_000);

const attributesSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .default({});

export const listingCreateSchema = z.object({
  title: titleSchema,
  description: descriptionSchema,
  price: priceSchema,
  currency: z.string().length(3).toUpperCase().default('EUR'),
  categoryId: z.string().cuid(),
  city: citySchema,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  attributes: attributesSchema,
  imageKeys: z
    .array(
      z.object({
        key: z.string().min(1).max(500),
        position: z.number().int().min(0),
      })
    )
    .max(LISTING_IMAGE_LIMIT, `Максимум ${LISTING_IMAGE_LIMIT} фото`)
    .optional()
    .default([]),
});

export const listingUpdateSchema = listingCreateSchema
  .partial()
  .extend({
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'Нет полей для обновления',
  });

export const listingQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().cuid().optional(),
  city: z.string().trim().max(120).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(0.1).max(2000).default(50),
  status: z.enum(['ACTIVE', 'SOLD']).default('ACTIVE'),
  sort: z
    .enum(['relevance', 'date_desc', 'date_asc', 'price_asc', 'price_desc'])
    .default('date_desc'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sellerId: z.string().cuid().optional(),
  attrs: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.object({ min: z.number().optional(), max: z.number().optional() }),
      ])
    )
    .optional(),
  favoritesOf: z.string().cuid().optional(),
});

export const listingIdSchema = z.object({
  id: z.string().cuid(),
});

export const imagePresignSchema = z.object({
  listingId: z.string().cuid().optional(),
  mime: z.enum(ALLOWED_IMAGE_MIME),
  extension: z.enum(ALLOWED_IMAGE_EXT),
  sizeBytes: z.number().int().min(1).max(5 * 1024 * 1024),
});

export const createImagesDoneSchema = z.object({
  imageKeys: z
    .array(
      z.object({
        key: z.string().min(1).max(500),
        position: z.number().int().min(0),
      })
    )
    .max(LISTING_IMAGE_LIMIT),
});

export const favoriteSchema = z.object({
  listingId: z.string().cuid(),
});

export type ListingCreateInput = z.infer<typeof listingCreateSchema>;
export type ListingUpdateInput = z.infer<typeof listingUpdateSchema>;
export type ListingQueryInput = z.infer<typeof listingQuerySchema>;
export type ImagePresignInput = z.infer<typeof imagePresignSchema>;
