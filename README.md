# РынокRU — доска объявлений (Avito-like)

## Деплой на VPS (Ubuntu 24.04)

### Требования
- VPS с 2+ ГБ RAM
- Ubuntu 24.04
- Node.js 20, pnpm 9
- Docker (для PostgreSQL, Redis, MinIO)
- nginx, pm2, certbot

### Установка
1. Клонировать репо: `git clone <url> /root/marketplace`
2. Установить Node.js 20 и pnpm 9:
```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pnpm@9 pm2
```
3. Установить Docker и запустить инфраструктуру:
```
cd /root/marketplace
docker compose up -d postgres redis minio mailhog createbuckets
```
4. Установить зависимости и собрать:
```
pnpm install --no-frozen-lockfile
pnpm --filter @marketplace/shared build
pnpm --filter @marketplace/db build
pnpm --filter @marketplace/api build
pnpm --filter @marketplace/worker build
pnpm --filter @marketplace/web build
```
5. Применить миграции Prisma:
```
cd packages/db && pnpm exec prisma migrate deploy && cd ../..
```
6. Установить nginx и скопировать конфиг:
```
apt install -y nginx certbot python3-certbot-nginx
cp deploy/nginx.conf /etc/nginx/sites-available/rinokru
ln -sf /etc/nginx/sites-available/rinokru /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```
7. Запустить приложения через pm2:
```
pm2 start /root/marketplace/start-api.sh --name api
pm2 start /root/marketplace/start-worker.sh --name worker
pm2 start /root/marketplace/start-web.sh --name web
pm2 save
pm2 startup
```
8. Получить SSL (после того как DNS пропагируется):
```
certbot --nginx -d rinokru.com -d www.rinokru.com -d s3.rinokru.com
```

---
Full-stack: **Next.js 14 (web) + Express (api) + BullMQ worker + PostgreSQL + Redis + MinIO (S3) + ЮKassa (эскроу, сплитование платежей)**. Монорепо на pnpm.

---

## Куда вставлять ключи (для клиента)

Откройте `.env.example`, скопируйте в `.env` и заполните **обязательные блоки** (БД/Redis, JWT) и те, что нужны:

```bash
cp .env.example .env
```

| Блок | Где взять | Что вставить |
|------|-----------|--------------|
| **PostgreSQL / Redis** | совпадает с `docker-compose.yml` | значения уже стоят, укажите свой `DATABASE_URL`/`REDIS_URL`, если БД внешняя |
| **JWT** *(обязательно)* | `openssl rand -base64 48` (два раза, два РАЗНЫХ значения) | `JWT_ACCESS_SECRET` и `JWT_REFRESH_SECRET` |
| **ЮKassa** *(нужна для платежей и выплат)* | Личный кабинет ЮKassa (https://yookassa.ru) → «Настройки» → «API» | `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` (для разработки — ключ из тестовой среды) |
| **Яндекс SmartCaptcha** *(опционально)* | Яндекс Облако → SmartCaptcha → ключи | `SMARTCAPTCHA_SECRET_KEY`, `SMARTCAPTCHA_ENABLED=true` |
| **SMTP** *(опционально)* | провайдер писем (Yandex, Mail.ru, SendGrid…) или MailHog из compose | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` |
| **SMS.RU** *(опционально)* | https://sms.ru → API | `SMS_RU_API_KEY` (пусто = заглушка, коды в логах worker'а) |

Без ЮKassa сайт заводится — каталог, чат, профиль, регистрация по телефону работают, платёжные эндпоинты отвечают 500 «ЮKassa не настроен». Без JWT-ключей API не стартует вообще.

Вебхуки ЮKassa настраиваются в ЛК ЮKassa → «Настройки» → «Уведомления» (URL `https://<ваш-домен>/api/webhooks/yookassa`). Для локальной разработки нужен туннель (ngrok/cloudflared) — при этом в `.env` поставьте `YOOKASSA_INSECURE_WEBHOOKS=true`, чтобы API не отсекал уведомления по IP-аллоулисту.

Вход — только по номеру телефона и паролю, сторонние сервисы входа не подключаются.

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
pnpm db:seed                  # категории + регионы (без аккаунтов)
pnpm create:admin             # создать администратора (интерактивно)
pnpm dev                      # web :3000, api :4000, worker (3 окна concurrently)
```

Проверка: http://localhost:3000 (web), http://localhost:4000/healthz (api → `{"status":"ok"}`), http://localhost:9001 (MinIO, minioadmin/minioadmin), http://localhost:8025 (MailHog).

## Прод (Docker)

```bash
cp .env.example .env          # вставьте боевые ключи (ЮKassa/SmartCaptcha/SMTP/SMS.RU)
docker compose up --build -d  # соберёт api/worker/web, поднимет postgres/redis/minio
docker compose ps             # все healthy?
docker compose logs -f api worker web
```

`NEXT_PUBLIC_API_URL` и `NEXT_PUBLIC_APP_URL` для web заданы в `docker-compose.yml` (environment). Платёжный виджет ЮKassa (`checkout-widget.js`) публичных ключей не требует — фронт получает `confirmation_token` от бэкенда при создании заказа.

## Администратор (после `pnpm db:seed`)

Seed не создаёт аккаунтов — администратор заводится из консоли:

```bash
pnpm create:admin                                        # интерактивно
# или сразу с параметрами:
pnpm create:admin -- --email admin@example.com --phone +79991234567 --password 'Secret123'
```

Требования к паролю: минимум 8 символов, заглавная + строчная буква + цифра.
Повторный запуск с тем же email обновляет пароль/телефон; вход на сайте — по телефону и паролю.
Обычные пользователи регистрируются на сайте как обычно.

## Полный цикл (ручная проверка)

1. Зарегистрируйтесь как продавец → на странице `/seller/connect` укажите **Shop ID вашего магазина ЮKassa** (магазин должен быть создан в ЛК ЮKassa и пройти модерацию) → создайте листинг.
2. Зарегистрируйтесь вторым пользователем как покупатель → купите листинг тестовой картой ЮKassa (например, `5555 5555 5555 4444`; полный список тестовых карт — в документации ЮKassa).
3. Подтвердите получение (release) — статус заказа `PAID → RELEASED`, объявление `RESERVED → SOLD`, деньги переводятся продавцу в тестовом личном кабинете ЮKassa (сплитование при capture).
4. Проверьте логи worker'а — джобы модерации, изображений, уведомлений.

## Эскроу (ЮKassa, двухстадийный платёж)

1. `POST /api/orders` → ЮKassa Payment с `two_stage=true` (capture_method=manual) и `confirmation` embedded → заказ `PENDING`, объявление `ACTIVE → RESERVED`, фронту возвращается `confirmationToken` для виджета.
2. Уведомление `payment.waiting_for_capture` → заказ `PENDING → PAID` (деньги удержаны платформой).
3. Покупатель подтверждает получение → capture. ЮKassa сама расщепляет сумму (комиссия платформы + доля продавца) и переводит продавцу — заказ `RELEASED`, объявление `SOLD`.
4. Уведомление `payment.succeeded` **никогда** не делает авто-RELEASE — только доводит `PENDING` до `PAID`.

Возвраты: уведомление `refund.succeeded` переводит `PAID`-заказ в `REFUNDED` и возвращает объявление в выдачу; уже выплаченные (`RELEASED`) заказы не трогает (уведомление админу).

## Команды

```bash
pnpm typecheck              # tsc во всех пакетах
pnpm test                   # vitest по всем пакетам; интеграционные идут при доступных БД/Redis (ЮKassa мокается через fetch)
pnpm --filter @marketplace/web test:e2e  # playwright (нужен запущенный web)
pnpm build                  # сборка всех пакетов (shared → db → api → web → worker)
```

## Структура

- `apps/api` — Express API (валидация zod, JWT, rate-limit, SmartCaptcha)
- `apps/web` — Next.js App Router (каталог, листинги, чат, заказы, кабинет, админка, виджет ЮKassa `checkout-widget.js`)
- `apps/worker` — BullMQ (emails, sms via sms.ru, images/sharp, moderation, saved-search, maintenance)
- `packages/db` — Prisma schema/migrations/seed (Postgres + tsvector поиск)
- `packages/shared` — zod-схемы, константы, типы очередей