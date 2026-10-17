import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { buildCsp } from './src/lib/csp';

/**
 * Аудит п.34: nonce-CSP для прод-страниц.
 * CSP уходит и в request-заголовке (Next читает nonce оттуда и проставляет
 * его своим инлайн-скриптам), и в response-заголовке (браузер применяет).
 * В dev CSP не ставим — инлайн-скрипты React Refresh/HMR иначе блокируются.
 */
export function middleware(req: NextRequest) {
  if (process.env.NODE_ENV !== 'production') {
    return NextResponse.next();
  }

  const nonce = randomBytes(16).toString('base64');
  const csp = buildCsp({
    nonce,
    apiOrigin: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    s3Origin: process.env.NEXT_PUBLIC_S3_PUBLIC_URL,
  });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('Content-Security-Policy', csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  // Статику и картинки Next не трогаем — CSP нужен документам.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
