# Marketplace — доска объявлений (Avito-like)

Full-stack: **Next.js 14 (web) + Express (api) + BullMQ worker + PostgreSQL + Redis + MinIO (S3) + Stripe Connect (эскроу)**. Монорепо на pnpm.

## Быстрый старт (локально)

```bash
cp .env.example .env          # заполнить Stripe / Google при необходимости
pnpm install
docker compose up -d postgres redis minio   # инфраструктура
pnpm db:deploy                # миграции
pnpm db:seed                  # админ + категории
pnpm dev                      # web :3000, api :4000, worker
```

- Web: http://localhost:3000, API: http://localhost:4000 (`/healthz`).
- MinIO: http://localhost:9001 (minioadmin/minioadmin), корзина `marketplace` (создаётся `createbuckets`).
- MailHog: http://localhost:8025 (SMTP `:1025`) — письма воркера видны в UI, без него email-джобы ретраятся.
- Без SMTP и Stripe-ключей приложение стартует, а соответствующие функции возвращают понятную ошибку / сообщение в UI.

## Прод (Docker)

```bash
docker compose up --build     # postgres, redis, minio, api, worker, web
```

## Проверки

```bash
pnpm typecheck   # tsc во всех пакетах
pnpm test        # vitest (shared + api unit; интеграции скипаются без БД)
pnpm --filter @marketplace/web test:e2e   # playwright (нужен запущенный web)
```

## Эскроу-платежи (Stripe, manual capture)

1. `POST /api/orders` создаёт `PaymentIntent(capture_method=manual)` + заказ `PENDING`.
2. Вебхук `payment_intent.amount_capturable_updated` переводит заказ в `PAID` (деньги удержаны).
3. Покупатель подтверждает получение → `releaseOrder`: `capture + transfer` продавцу, заказ `RELEASED`, объявление `SOLD`.
4. Вебхук `payment_intent.succeeded` **никогда** не делает авто-RELEASE — только доводит `PENDING` до `PAID`.

Без `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` платёжные эндпоинты отвечают `500 Stripe не настроен`.

## Auth

Телефон + пароль (argon2id), JWT access/refresh с ротацией, Google OAuth (`/api/auth/oauth/google`). Email оставлен опциональным.

## Структура

- `apps/api` — Express API
- `apps/web` — Next.js App Router
- `apps/worker` — BullMQ (emails, sms, images, moderation, notifications, maintenance)
- `packages/db` — Prisma schema/migrations/seed
- `packages/shared` — zod-схемы, константы, очереди
