import { z } from 'zod';

export const regionCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'Только латиница, цифры и дефис')
    .optional(),
  sortOrder: z.number().int().min(0).max(100000).default(0),
});

export const regionUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[a-z0-9-]+$/, 'Только латиница, цифры и дефис')
      .optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Нет полей для обновления' });

export const cityCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  regionId: z.string().cuid(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'Только латиница, цифры и дефис')
    .optional(),
  sortOrder: z.number().int().min(0).max(100000).default(0),
});

export const cityUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    regionId: z.string().cuid().optional(),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[a-z0-9-]+$/, 'Только латиница, цифры и дефис')
      .optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Нет полей для обновления' });

export type RegionCreateInput = z.infer<typeof regionCreateSchema>;
export type RegionUpdateInput = z.infer<typeof regionUpdateSchema>;
export type CityCreateInput = z.infer<typeof cityCreateSchema>;
export type CityUpdateInput = z.infer<typeof cityUpdateSchema>;
