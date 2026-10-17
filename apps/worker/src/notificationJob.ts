import { prisma } from '@marketplace/db';
import { sendEmail } from './mailer.js';

interface NotificationJobData {
  userId: string;
  listingId: string;
}

/** Уведомление о совпадении сохранённого поиска для конкретного пользователя. */
export async function savedSearchNotificationJob(data: NotificationJobData): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { id: true, email: true, name: true, savedSearches: { where: { notifyNew: true } } },
  });
  if (!user || user.savedSearches.length === 0) return;
  if (!user.email) return;

  const listing = await prisma.listing.findUnique({
    where: { id: data.listingId },
    select: { id: true, title: true, price: true, city: true, categoryId: true },
  });
  if (!listing) return;

  const matched = user.savedSearches.some((search) => {
    const query = (search.query ?? {}) as Record<string, unknown>;
    return matchesSearch(query, listing);
  });
  if (!matched) return;

  // Одно письмо на листинг, даже если совпало несколько сохранённых поисков.
  // Аудит п.39: title/city объявления вставляем в plain-text только после
  // очистки — иначе ссылка в названии превратилась бы в кликабельный URL
  // в письме от имени площадки (фишинг).
  const summary = sanitizeEmailPlainText(`${listing.title} — ${listing.price} ${listing.city ?? ''}`);
  await sendEmail({
    to: user.email,
    subject: 'Новое объявление по вашему поиску',
    text: `${summary}\n${process.env.APP_URL ?? 'http://localhost:3000'}/listings/${listing.id}`,
    template: 'new-message',
    templateData: {
      name: user.name,
      preview: summary,
    },
  });
}

/**
 * Аудит п.39: очистка пользовательского текста для plain-text части письма.
 * - управляющие символы (в т.ч. переводы строк) → пробелы;
 * - множественные пробелы схлопываются;
 * - URL дефангим (`://` → `[://]`, `www.` → `www[.]`), чтобы почтовые
 *   клиенты не распознавали их как ссылки.
 */
export function sanitizeEmailPlainText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/https?:\/\//gi, (m) => m.replace('://', '[://]'))
    .replace(/\bwww\./gi, 'www[.]');
}

function matchesSearch(
  query: Record<string, unknown>,
  listing: { title: string; city: string; price: unknown; categoryId: string }
): boolean {
  if (query.city && typeof query.city === 'string' && query.city !== '' && query.city !== listing.city) {
    return false;
  }
  if (query.category && typeof query.category === 'string' && query.category !== '' && query.category !== listing.categoryId) {
    return false;
  }
  const price = Number(listing.price);
  if (query.minPrice !== undefined && query.minPrice !== null && query.minPrice !== '') {
    const min = Number(query.minPrice);
    if (Number.isFinite(min) && price < min) return false;
  }
  if (query.maxPrice !== undefined && query.maxPrice !== null && query.maxPrice !== '') {
    const max = Number(query.maxPrice);
    if (Number.isFinite(max) && price > max) return false;
  }
  if (query.q && typeof query.q === 'string' && query.q.trim() !== '') {
    const q = query.q.toLowerCase();
    if (!listing.title.toLowerCase().includes(q)) return false;
  }
  return true;
}
