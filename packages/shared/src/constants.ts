export const CURSOR_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export const LISTING_IMAGE_LIMIT = 20;
export const MESSAGE_LENGTH_LIMIT = 2000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'] as const;

export const USER_ROLES = ['USER', 'MODERATOR', 'ADMIN'] as const;
export const LISTING_STATUSES = ['PENDING', 'ACTIVE', 'RESERVED', 'SOLD', 'REJECTED', 'ARCHIVED'] as const;
export const ORDER_STATUSES = ['PENDING', 'PAID', 'RELEASING', 'RELEASED', 'REFUNDED', 'DISPUTED'] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Идемпотентные ключи Stripe для выплаты (releaseOrder и recovery-джоба worker'а
 * обязаны использовать один и тот же формат: повторный прогон с тем же ключом
 * Stripe возвращает исходный результат, не создавая дубликата перевода).
 */
export const releaseCaptureIdempotencyKey = (orderId: string) => `release-capture-${orderId}`;
export const releaseTransferIdempotencyKey = (orderId: string) => `release-${orderId}`;

export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

export const MODERATION_BLOCKED_KEYWORDS = [
  'наркотик',
  'наркота',
  'мефедрон',
  'взрывчатк',
  'бомба',
  'оружие',
  'пистолет',
  'автомат',
  'детская порнограф',
  'порно с детьми',
  'проституц',
  'эскорт',
  'казино',
  'ставк',
  'фейк',
  'подделка',
  'украден',
  'ворован',
  'паспорт',
  'диплом купить',
] as const;
