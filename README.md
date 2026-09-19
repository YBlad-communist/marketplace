# Marketplace — доска объявлений (Avito-like)

Full-stack: **Next.js 14 (web) + Express (api) + BullMQ worker + PostgreSQL + Redis + MinIO (S3) + Stripe Connect (эскроу)**. Монорепо на pnpm.

---

## Куда вставлять ключи (для клиента)

Откройте `.env.example`, скопируйте в `.env` и заполните **только 3 блока**:

```bash
cp .env.example .env
```

| Блок | Где взять | Что вставить |
|------|-----------|--------------|
| **JWT** | `openssl rand -base64 48` (два раза, два РАЗНЫХ значения) | `JWT_ACCESS_SECRET` и `JWT_REFRESH_SECRET` |
| **Stripe** | https://dashboard.stripe.com/test/apikeys (Test mode) | `sk_test_...` → `STRIPE_SECRET_KEY`, `pk_test_...` → `STRIPE_PUBLISHABLE_KEY` и `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |
| **Google OAuth** *(опционально)* | https://console.cloud.google.com/apis/credentials → Create OAuth client (Web) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Redirect URI: `http://localhost:4000/api/auth/oauth/google/callback` |

Остальное уже настроено под `docker-compose.yml`. Без Stripe/Google сайт заводится — платежи и OAuth просто отвечают 500/skip, каталог/чат/профиль работают.

Webhook для локальной разработки:
```bash
stripe login
stripe listen --forward-to localhost:4000/api/webhooks/stripe
# скопируйте whsec_... из вывода в STRIPE_WEBHOOK_SECRET и перезапустите api
```

---

## Быстрый старт (локально, без Docker)

```bash
cp .env.example .env          # вставьте ключи как выше
pnpm install
pnpm --filter @marketplace/shared build
pnpm --filter @marketplace/db db:generate

# инфраструктура — если Docker есть:
docker compose up -d postgres redis minio createbuckets mailhog
# если Docker нет — запустите Postgres и Redis локально (MinIO опционально)

pnpm db:deploy                # миграции (или pnpm --filter @marketplace/db db:push для dev)
pnpm db:seed                  # админ + 5 категорий
pnpm dev                      # web :3000, api :4000, worker (3 окна concurrently)
```

Проверка: http://localhost:3000 (web), http://localhost:4000/healthz (api → `{"status":"ok"}`), http://localhost:9001 (MinIO, minioadmin/minioadmin), http://localhost:8025 (MailHog).

## Прод (Docker)

```bash
cp .env.example .env          # вставьте боевые ключи
docker compose up --build -d  # соберёт api/worker/web, поднимет postgres/redis/minio
docker compose ps             # все healthy?
docker compose logs -f api worker web
```

Переменные `NEXT_PUBLIC_*` для web подставляются из `.env` автоматически (см. `docker-compose.yml`).

## Тестовые аккаунты (после `pnpm db:seed`)

| Роль | Email | Телефон | Пароль |
|------|-------|---------|--------|
| Admin | admin@marketplace.local | +79990000001 | Admin123! |
| Demo-продавец | demo@marketplace.local | +79990001122 | Demo123! |

## Полный цикл (ручная проверка)

1. Зарегистрируйтесь как продавец → подключите Stripe Connect (`/seller/connect`, тестовый онбординг) → создайте листинг.
2. Зарегистрируйтесь вторым пользователем как покупатель → купите листинг тестовой картой `4242 4242 4242 4242`.
3. Подтвердите получение (release) — статус заказа `PAID → RELEASED`, объявление `RESERVED → SOLD`, деньги у продавца в Stripe test dashboard.
4. Проверьте логи worker'а — джобы модерации, изображений, уведомлений.

## Эскроу (Stripe, manual capture)

1. `POST /api/orders` → `PaymentIntent(capture_method=manual)` + заказ `PENDING`, объявление `ACTIVE → RESERVED`.
2. Вебхук `payment_intent.amount_capturable_updated` → заказ `PENDING → PAID` (деньги удержаны).
3. Покупатель подтверждает → `capture + transfer` продавцу, заказ `RELEASED`, объявление `SOLD`.
4. Вебхук `payment_intent.succeeded` **никогда** не делает авто-RELEASE — только доводит `PENDING` до `PAID`.

## Команды

```bash
pnpm typecheck              # tsc во всех пакетах
pnpm test                   # vitest (shared + api unit; интеграции скипаются без БД)
pnpm --filter @marketplace/web test:e2e  # playwright (нужен запущенный web)
pnpm build                  # сборка всех пакетов (shared → db → api → web → worker)
```

## Структура

- `apps/api` — Express API (валидация zod, JWT, rate-limit, Turnstile)
- `apps/web` — Next.js App Router (каталог, листинги, чат, заказы, кабинет, админка, Stripe Elements)
- `apps/worker` — BullMQ (emails, sms via sms.ru, images/sharp, moderation, saved-search, maintenance)
- `packages/db` — Prisma schema/migrations/seed (Postgres + tsvector поиск)
- `packages/shared` — zod-схемы, константы, типы очередей
