import { NextFunction, Request, Response } from 'express';
import { ZodTypeAny } from 'zod';
import { zodToAppError } from '@marketplace/shared';

type Location = 'body' | 'query' | 'params';

export function validate(schema: ZodTypeAny, location: Location = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const source = location === 'params' ? req.params : location === 'query' ? req.query : req.body;
    const result = schema.safeParse(source);
    if (!result.success) {
      return next(zodToAppError(result.error));
    }
    if (location === 'body') req.body = result.data;
    else if (location === 'query') req.query = result.data as unknown as Request['query'];
    else req.params = result.data as unknown as Request['params'];
    next();
  };
}
