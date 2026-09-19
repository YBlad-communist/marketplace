import { z } from 'zod';

export const errorCodes = {
  VALIDATION: 'VALIDATION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  GONE: 'GONE',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly fields?: Record<string, string>;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode?: number,
    fields?: Record<string, string>,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode ?? statusCodeFromCode(code);
    this.fields = fields;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function statusCodeFromCode(code: ErrorCode): number {
  switch (code) {
    case errorCodes.VALIDATION:
      return 400;
    case errorCodes.UNAUTHORIZED:
      return 401;
    case errorCodes.FORBIDDEN:
      return 403;
    case errorCodes.NOT_FOUND:
      return 404;
    case errorCodes.CONFLICT:
      return 409;
    case errorCodes.RATE_LIMITED:
      return 429;
    case errorCodes.PAYMENT_REQUIRED:
      return 402;
    case errorCodes.GONE:
      return 410;
    default:
      return 500;
  }
}

export function zodToAppError(error: z.ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (path && !fields[path]) {
      fields[path] = issue.message;
    }
  }
  return new AppError(errorCodes.VALIDATION, 'Проверьте правильность заполнения полей', 400, fields);
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof z.ZodError) return zodToAppError(err);
  // PrismaClientKnownRequestError без зависимости от prisma: проверяем только
  // имя класса и code. Без этого маппинга штатные конфликты БД (повторный
  // отзыв, удаление объявления с заказом) выглядели бы как падение сервера.
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'PrismaClientKnownRequestError' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    const code = (err as { code: string }).code;
    if (code === 'P2002') {
      return new AppError(errorCodes.CONFLICT, 'Запись уже существует (конфликт уникальности)', 409, undefined, { prismaCode: code });
    }
    if (code === 'P2003') {
      return new AppError(errorCodes.CONFLICT, 'Запись используется другими данными', 409, undefined, { prismaCode: code });
    }
    if (code === 'P2025') {
      return new AppError(errorCodes.NOT_FOUND, 'Запись не найдена', 404, undefined, { prismaCode: code });
    }
  }
  // Postgres RESTRICT/FOREIGN KEY violation пробивается как
  // PrismaClientUnknownRequestError (23001) — например, DELETE объявления
  // с заказом. Это штатный конфликт, а не падение сервера.
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'PrismaClientUnknownRequestError' &&
    err instanceof Error &&
    err.message.includes('RESTRICT')
  ) {
    return new AppError(errorCodes.CONFLICT, 'Запись используется другими данными', 409, undefined, { prismaCode: '23001' });
  }
  return new AppError(errorCodes.INTERNAL, 'Внутренняя ошибка сервера', 500);
}
