/** @type {import('next').NextConfig} */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
  typedRoutes: false,
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '9000' },
      { protocol: 'https', hostname: '**' },
    ],
  },
  async headers() {
    // Строгий CSP — только для production: в dev-режиме Next.js сам
    // инжектит inline-скрипты и использует eval (react-refresh/HMR),
    // поэтому там эти заголовки ломали бы страницу (см. ошибки CSP в консоли).
    if (process.env.NODE_ENV !== 'production') return [];
    // DECISION: script-src вынужденно содержит 'unsafe-inline' — Next.js 15
    // встраивает runtime-скрипты инлайном, их хэши меняются каждую сборку,
    // а nonce потребовал бы middleware. Остальные директивы держим строгими.
    // connect-src/img-src покрывают API (:4000), S3 (:9000) и ЮKassa —
    // без этого дохнут сокеты, загрузка фото и гидрация.
    const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    const wsOrigin = apiOrigin.replace(/^http/, 'ws');
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://yookassa.ru https://*.yookassa.ru",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https: http:",
              `connect-src 'self' ${apiOrigin} ${wsOrigin} http://localhost:3000 http://localhost:4000 http://localhost:9000 http://127.0.0.1:3000 http://127.0.0.1:4000 http://127.0.0.1:9000 http://192.168.0.149:3000 http://192.168.0.149:4000 http://192.168.0.149:9000 ws://localhost:4000 ws://127.0.0.1:4000 ws://192.168.0.149:4000 https://yookassa.ru https://*.yookassa.ru wss://yookassa.ru wss://*.yookassa.ru`,
              "frame-src https://yookassa.ru https://*.yookassa.ru",
              "frame-ancestors 'none'",
            ].join('; '),
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
