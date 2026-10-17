/**
 * Аудит п.34: Content-Security-Policy прод-страниц Next.
 *
 * - script-src без 'unsafe-inline' — свои инлайн-скрипты Next получают nonce
 *   (middleware кладёт CSP в request-заголовки, Next сам проставляет nonce
 *   своим скриптам через getScriptNonceFromHeader);
 * - img-src без wildcard-схем `http:`/`https:` — только self/data/blob и домен S3;
 * - connect-src без localhost/127.0.0.1 и http:// (в production).
 *
 * CSP выставляется только в production (в dev инлайн-скрипты React Refresh
 * и HMR ломались бы на nonce) — см. middleware.ts.
 */
export interface CspOptions {
  /** Разовый nonce запроса (base64). */
  nonce: string;
  /** NEXT_PUBLIC_API_URL — REST и WebSocket бэкенда. */
  apiOrigin: string;
  /** NEXT_PUBLIC_S3_PUBLIC_URL — прямые presigned-загрузки и картинки. */
  s3Origin?: string;
}

const YOOKASSA = ['https://yookassa.ru', 'https://*.yookassa.ru'];

/** В прод-CSP не попадают http:// и loopback-адреса. */
function isProdSafeSource(src: string): boolean {
  if (src.startsWith('http://')) return false;
  if (/localhost|127\.0\.0\.1/.test(src)) return false;
  return true;
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

export function buildCsp({ nonce, apiOrigin, s3Origin }: CspOptions): string {
  // WebSocket живёт на origin API без суффикса /api (см. socket.io path).
  const apiHost = apiOrigin.replace(/\/+$/, '').replace(/\/api$/, '');
  const wsOrigin = apiHost.replace(/^http/, 'ws');

  const imgSrc = unique(["'self'", 'data:', 'blob:', 'https://s3.rinokru.com', s3Origin ?? '']).filter(
    (s) => s !== '' && isProdSafeSource(s)
  );

  // fetch()/WebSocket браузера: API, WS, presigned PUT в S3, виджет ЮKassa.
  const connectSrc = unique([
    "'self'",
    apiOrigin,
    wsOrigin,
    s3Origin ?? '',
    'https://yookassa.ru',
    'wss://yookassa.ru',
  ]).filter((s) => s !== '' && isProdSafeSource(s));

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${YOOKASSA.join(' ')}`,
    // style-src остаётся с 'unsafe-inline': Next и Tailwind инлайнят стили.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    `frame-src ${YOOKASSA.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}
