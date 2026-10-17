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
    // Аудит п.34: только конкретный https-домен S3 — без wildcard '**' и
    // без http-вариантов. При этом страницы используют /api/files (один origin),
    // а next/image сейчас нигде не применяется.
    remotePatterns: [{ protocol: 'https', hostname: 's3.rinokru.com' }],
  },
  async headers() {
    if (process.env.NODE_ENV !== 'production') return [];
    // CSP (с nonce) выставляет middleware.ts — здесь только статические
    // security-заголовки, включая HSTS (аудит п.34).
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
