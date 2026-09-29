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
      { protocol: 'http', hostname: 's3.rinokru.com' },
      { protocol: 'https', hostname: 's3.rinokru.com' },
      { protocol: 'https', hostname: '**' },
    ],
  },
  async headers() {
    if (process.env.NODE_ENV !== 'production') return [];
    const apiOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    // Убираем путь /api — WebSocket живёт на /socket.io/, а не на /api/.
    const apiHost = apiOrigin.replace(/\/api\/?$/, '');
    const wsOrigin = apiHost.replace(/^http/, 'ws');
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
              "img-src 'self' data: blob: http://s3.rinokru.com https://s3.rinokru.com https: http:",
              `connect-src 'self' ${apiOrigin} ${wsOrigin} http://rinokru.com https://rinokru.com ws://rinokru.com wss://rinokru.com http://s3.rinokru.com https://s3.rinokru.com http://localhost:3000 http://localhost:4000 http://localhost:9000 http://127.0.0.1:3000 http://127.0.0.1:4000 http://127.0.0.1:9000 ws://localhost:4000 ws://127.0.0.1:4000 https://yookassa.ru https://*.yookassa.ru wss://yookassa.ru wss://*.yookassa.ru`,
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
