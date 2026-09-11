export interface ApiError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export interface ApiResponse<T> {
  data: T;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export function ok<T>(data: T): ApiResponse<T> {
  return { data };
}

export function page<T>(items: T[], nextCursor: string | null, total: number): CursorPage<T> {
  return { items, nextCursor, total };
}
