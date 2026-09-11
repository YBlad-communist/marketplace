import { describe, expect, it } from 'vitest';
import { CURSOR_PAGE_SIZE, AppError, zodToAppError, page, ok } from '../src/index.js';
import { z } from 'zod';

describe('errors', () => {
  it('maps zod errors to fields map', () => {
    const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
    const err = zodToAppError(schema.safeParse({ email: 'bad', password: 'x' }).error as never);
    expect(err.code).toBe('VALIDATION');
    expect(err.statusCode).toBe(400);
    expect(err.fields?.email).toBeDefined();
    expect(err.fields?.password).toBeDefined();
  });

  it('AppError keeps status code', () => {
    const e = new AppError('FORBIDDEN', 'нет доступа');
    expect(e.statusCode).toBe(403);
  });
});

describe('constants & helpers', () => {
  it('page size constants are sane', () => {
    expect(CURSOR_PAGE_SIZE).toBe(20);
  });
  it('ok/page envelope helpers', () => {
    expect(ok(1)).toEqual({ data: 1 });
    expect(page([1], null, 1)).toEqual({ items: [1], nextCursor: null, total: 1 });
  });
});
