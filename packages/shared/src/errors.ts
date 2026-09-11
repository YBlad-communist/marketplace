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
  return new AppError(errorCodes.INTERNAL, 'Внутренняя ошибка сервера', 500);
}
