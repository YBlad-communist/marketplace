import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  JWT_ISSUER: z.string().default('marketplace-api'),

  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Пусто = host-only кука (без Domain): работает на любом хосте —
  // localhost, 127.0.0.1, LAN-IP. Domain=localhost ломал refresh везде,
  // кроме буквального localhost (кука туда просто не отправляется).
  COOKIE_DOMAIN: z.string().optional().default(''),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().default('marketplace'),
  S3_ACCESS_KEY_ID: z.string().default('minioadmin'),
  S3_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  S3_PUBLIC_BASE_URL: z.string().default('http://localhost:9000/marketplace'),
  S3_MAX_IMAGE_BYTES: z.coerce.number().default(5 * 1024 * 1024),

  YOOKASSA_SHOP_ID: z.string().optional(),
  YOOKASSA_SECRET_KEY: z.string().optional(),
  YOOKASSA_PLATFORM_FEE_BASIS_POINTS: z.coerce.number().default(200),
  // Срок холда (дней): holdExpiresAt = createdAt + TTL. ЮKassa сама отменяет
  // авторизации ~через 7 дней; должен совпадать с worker'ом (apps/worker/src/config.ts).
  YOOKASSA_HOLD_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  // Отключить проверку IP уведомлений ЮKassa (только для разработки через туннель).
  YOOKASSA_INSECURE_WEBHOOKS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // --- Платёжный провайдер (yookassa | moneta | mock) ---
  // Реализация создаётся один раз в фабрике (services/payments/factory).
  PAYMENT_PROVIDER: z.enum(['yookassa', 'moneta', 'mock']).default('yookassa'),
  // Провайдер-нейтральные комиссия/срок холда; YOOKASSA_* остаются фолбэком
  // на время переезда (тесты и текущие деплои задают только YOOKASSA_*).
  PLATFORM_FEE_BASIS_POINTS: z.coerce.number().optional(),
  HOLD_TTL_DAYS: z.coerce.number().int().min(1).optional(),

  // --- Монета (docs.moneta.ru) ---
  // MNT_ID расширенного счёта площадки (транзитный приём платежей).
  MONETA_ACCOUNT_ID: z.string().optional(),
  // Код проверки целостности данных («код проверки» в ЛК счёта) — для MNT_SIGNATURE.
  MONETA_ACCOUNT_CODE: z.string().optional(),
  // Транзитный счёт площадки (payer при переводе продавцу в безопасной сделке).
  MONETA_TRANSIT_ACCOUNT: z.string().optional(),
  // MerchantAPI (SOAP): https://service.moneta.ru/services (см. docs.moneta.ru/protocols).
  MONETA_BASE_URL: z.string().url().default('https://service.moneta.ru/services'),
  // Логин/пароль ЛК Монеты для MerchantAPI (UsernameToken/Basic).
  MONETA_API_USERNAME: z.string().optional(),
  MONETA_API_PASSWORD: z.string().optional(),
  // Платёжный пароль счёта (для PaymentRequest в безопасной сделке).
  MONETA_PAYMENT_PASSWORD: z.string().optional(),
  // 1 — тестовый режим Assistant (MNT_TEST_MODE), без реального списания.
  MONETA_TEST_MODE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Платёжная форма Assistant: demo.moneta.ru — тестовая площадка.
  MONETA_ASSISTANT_URL: z
    .string()
    .url()
    .default('https://moneta.ru/assistant.htm'),

  // Сколько прокси-хопов (nginx/Cloudflare) стоит между клиентом и API.
  // Express берёт правый (самый близкий к нам) адрес из X-Forwarded-For,
  // а левые, подделываемые клиентом, игнорирует. Число, а не true: иначе
  // rate limit обходится подменой заголовка.
  TRUST_PROXY_HOPS: z.coerce.number().default(1),

  // Минимальная сумма завершённого заказа для отзыва (анти-накрутка).
  REVIEW_MIN_ORDER_TOTAL: z.coerce.number().default(100),
  // Не больше N отзывов между одной парой пользователей за период (дни).
  REVIEW_PAIR_LIMIT: z.coerce.number().default(1),
  REVIEW_PAIR_WINDOW_DAYS: z.coerce.number().default(30),

  // Окно (мс) между дайджест-письмами о новых сообщениях одному получателю
  // в одном диалоге: за окно уходит не более 1 письма с агрегированным N.
  OFFLINE_EMAIL_COOLDOWN_MS: z.coerce.number().default(10 * 60_000),

  // Email администратора для уведомлений о спорах/возвратах (опционально).
  ADMIN_EMAIL: z.string().email().optional(),

  // Я.Капча (SmartCaptcha). Поле запроса сохраняется как `captchaToken`.
  SMARTCAPTCHA_SECRET_KEY: z.string().optional(),
  SMARTCAPTCHA_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  MAIL_FROM: z.string().default('РынокRU <no-reply@localhost>'),

  RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export const env = envSchema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Комиссия платформы в базисных пунктах (200 = 2%).
 * PLATFORM_FEE_BASIS_POINTS (провайдер-нейтральный) приоритетнее
 * YOOKASSA_LEGACY-поля — на время переезда.
 */
export const platformFeeBasisPoints =
  env.PLATFORM_FEE_BASIS_POINTS ?? env.YOOKASSA_PLATFORM_FEE_BASIS_POINTS;

/** Срок холда в днях (holdExpiresAt = createdAt + TTL). */
export const holdTtlDays = env.HOLD_TTL_DAYS ?? env.YOOKASSA_HOLD_TTL_DAYS;
