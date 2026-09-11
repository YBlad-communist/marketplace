import { z } from 'zod';
import { MIN_PASSWORD_LENGTH, PASSWORD_REGEX } from '../constants.js';

export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) digits = '7' + digits;
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  return '+' + digits;
}

export const phoneSchema = z
  .string()
  .trim()
  .refine((v) => /^\+?[0-9\s\-()]{7,20}$/.test(v), 'Некорректный телефон')
  .transform(normalizePhone);

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Имя должно быть не короче 2 символов').max(80),
    phone: phoneSchema,
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Пароль минимум ${MIN_PASSWORD_LENGTH} символов`)
      .max(72)
      .regex(PASSWORD_REGEX, 'Пароль должен содержать заглавную, строчную букву и цифру'),
    confirmPassword: z.string(),
    captchaToken: z.string().optional(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Пароли не совпадают',
    path: ['confirmPassword'],
  });

export const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1).max(72),
  captchaToken: z.string().optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(72),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH)
      .max(72)
      .regex(PASSWORD_REGEX),
    confirmNewPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmNewPassword, {
    message: 'Пароли не совпадают',
    path: ['confirmNewPassword'],
  });

export const verifyEmailSchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/),
});

export const forgotPasswordSchema = z.object({
  phone: phoneSchema,
});

export const resetPasswordSchema = z.object({
  phone: phoneSchema,
  code: z.string().length(6).regex(/^\d{6}$/),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .max(72)
    .regex(PASSWORD_REGEX),
});

export const requestVerificationSchema = z.object({
  type: z.enum(['email', 'phone']),
  phone: phoneSchema.optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type RequestVerificationInput = z.infer<typeof requestVerificationSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;