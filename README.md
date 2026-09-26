# РынокRU — доска объявлений (Avito-like)

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
pnpm db:seed                  # админ + 5 категорий
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

## Тестовые аккаунты (после `pnpm db:seed`)

| Роль | Email | Телефон | Пароль |
|------|-------|---------|--------|
| Admin | admin@marketplace.local | +79990000001 | Admin123! |
| Demo-продавец | demo@marketplace.local | +79990001122 | Demo123! |

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
python start.py             # полный локальный запуск (Redis, MinIO, миграции, web+api+worker)
python start.py --prod      # то же, но собранный код (быстрые переходы без dev-компиляции)
python infra/backup_db.py   # ручной бэкап БД в отдельное S3-хранилище
```

## Резервные копии БД

Бэкап лежит в **отдельном** бакете (`BACKUP_S3_BUCKET`, не там же, где фото) — копия рядом с базой не считается. Переменные — в `.env.example`, раздел «Резервное копирование БД».

- Скрипт: `python infra/backup_db.py` (Windows) / `infra/backup-db.sh` (Linux VPS).
  `pg_dump` в custom-формате → `s3://<BACKUP_S3_BUCKET>/postgres/<TIMESTAMP>.dump`
  (по воскресеньям — дубль в `postgres/weekly/`).
- Retention в самом скрипте: дневные старше 14 дней — удалить, недельные старше 90 — удалить.
- При падении — POST в `BACKUP_ALERT_WEBHOOK` (напр. Telegram Bot API).

### Расписание (вне приложения — бэкап должен работать, даже если API упало)

Windows (Планировщик заданий, ежедневно 3:00):
```
python C:\path\to\marketplace\infra\backup_db.py >> C:\logs\marketplace-backup.log 2>&1
```

Linux VPS (cron):
```bash
0 3 * * * cd /path/to/marketplace && ./infra/backup-db.sh >> /var/log/marketplace-backup.log 2>&1
```

### Восстановление БД из бэкапа

1. Скачать нужный дамп:
   `aws s3 cp s3://<BACKUP_S3_BUCKET>/postgres/<TIMESTAMP>.dump ./restore.dump --endpoint-url <BACKUP_S3_ENDPOINT>`
2. Поднять чистую базу: `createdb -h <host> -U marketplace marketplace_restored`
3. Восстановить: `pg_restore --dbname="postgresql://marketplace:<пароль>@<host>/marketplace_restored" --no-owner --clean ./restore.dump`
4. Сверить counts (`User`/`Listing`/`Order`/`Message`/`Review`) с ожидаемыми на момент бэкапа
5. Переключить `DATABASE_URL` приложения на восстановленную базу, перезапустить API/worker

Восстановление проверено вручную 2026-09-26: дамп из `marketplace-backups` накатан в `marketplace_restored`, counts сошлись 1-в-1 (26/17/0/36/0).

## Структура

- `apps/api` — Express API (валидация zod, JWT, rate-limit, SmartCaptcha)
- `apps/web` — Next.js App Router (каталог, листинги, чат, заказы, кабинет, админка, виджет ЮKassa `checkout-widget.js`)
- `apps/worker` — BullMQ (emails, sms via sms.ru, images/sharp, moderation, saved-search, maintenance)
- `packages/db` — Prisma schema/migrations/seed (Postgres + tsvector поиск)
- `packages/shared` — zod-схемы, константы, типы очередей