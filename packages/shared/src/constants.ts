export const CURSOR_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export const LISTING_IMAGE_LIMIT = 20;
export const MESSAGE_LENGTH_LIMIT = 2000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'] as const;

export const USER_ROLES = ['USER', 'MODERATOR', 'ADMIN'] as const;
export const LISTING_STATUSES = ['PENDING', 'ACTIVE', 'RESERVED', 'SOLD', 'REJECTED', 'ARCHIVED'] as const;
export const ORDER_STATUSES = ['PENDING', 'PAID', 'RELEASING', 'RELEASED', 'REFUNDING', 'REFUNDED', 'DISPUTED', 'SHIPPED'] as const;

/**
 * Активные (незавершённые) статусы заказа: по ним считается «не более одного
 * активного заказа на объявление» (частичный уникальный индекс в БД),
 * блокировка редактирования/удаления объявления и удаления аккаунта.
 * RELEASED/REFUNDED в списке нет — после них объявление снова продаётся.
 */
export const ACTIVE_ORDER_STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'RELEASING', 'REFUNDING', 'DISPUTED'] as const;

/**
 * Окна предупреждений покупателя о скором сгорании холда: письмо и баннер
 * на странице заказа за 2 дня и за 12 часов до holdExpiresAt.
 */
export const HOLD_WARN_2D_MS = 2 * 24 * 3600_000;
export const HOLD_WARN_12H_MS = 12 * 3600_000;

export type UserRole = (typeof USER_ROLES)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Идемпотентные ключи ЮKassa для платежа/возврата. Формат ключей общий для
 * paymentService (apps/api) и recovery-джоб worker'а: повторный прогон с тем же
 * Idempotence-Key не создаёт дубликата операции даже если пакет дошёл до API
 * повторно. ЮKassa ограничивает длину ключа 64 символами — наши префиксы с
 * cuid-заказом укладываются в лимит.
 */
export const releaseCaptureIdempotencyKey = (orderId: string) => `release-capture-${orderId}`;
export const refundCancelIdempotencyKey = (orderId: string) => `refund-cancel-${orderId}`;
export const refundIdempotencyKey = (orderId: string) => `refund-${orderId}`;
export const expiredHoldCancelIdempotencyKey = (orderId: string) => `expired-cancel-${orderId}`;

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

/**
 * Первое запрещённое ключевое слово в тексте или null.
 *
 * Совпадение засчитывается только в начале слова: раньше обычный includes
 * ловил «ставк» внутри «доставка» и отклонял обычные объявления про доставку.
 * Окончания слова при этом ловятся («наркотик» → «наркотики»), потому что
 * проверяется только символ перед найденным вхождением.
 */
export function findBlockedKeyword(text: string): string | null {
  const lower = text.toLowerCase();
  for (const keyword of MODERATION_BLOCKED_KEYWORDS) {
    let from = 0;
    let idx = lower.indexOf(keyword, from);
    while (idx !== -1) {
      const before = idx === 0 ? '' : lower[idx - 1];
      if (!before || !/[a-zа-яё]/.test(before)) return keyword;
      from = idx + 1;
      idx = lower.indexOf(keyword, from);
    }
  }
  return null;
}
