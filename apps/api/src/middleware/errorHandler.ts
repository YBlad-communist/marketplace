import { NextFunction, Request, Response } from 'express';
import { toAppError, AppError, errorCodes } from '@marketplace/shared';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(errorCodes.NOT_FOUND, 'Ресурс не найден', 404));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const appError = toAppError(err);

  if (appError.statusCode >= 500) {
    logger.error(
      {
        err,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
      },
      'unhandled error'
    );
  }

  const payload: Record<string, unknown> = {
    error: {
      code: appError.code,
      message: appError.message,
    },
  };
  if (appError.fields) {
    (payload.error as Record<string, unknown>).fields = appError.fields;
  }
  if (appError.details) {
    (payload.error as Record<string, unknown>).details = appError.details;
    if (typeof (appError.details as { retryAfterSeconds?: number }).retryAfterSeconds === 'number') {
      res.setHeader(
        'Retry-After',
        String((appError.details as { retryAfterSeconds: number }).retryAfterSeconds)
      );
    }
  }
  res.status(appError.statusCode).json(payload);
}
