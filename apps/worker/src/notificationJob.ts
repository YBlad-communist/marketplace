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
  await sendEmail({
    to: user.email,
    subject: 'Новое объявление по вашему поиску',
    text: `${listing.title} — ${listing.price} ${listing.city ?? ''}\n${process.env.APP_URL ?? 'http://localhost:3000'}/listings/${listing.id}`,
    template: 'new-message',
    templateData: {
      name: user.name,
      preview: `${listing.title} — ${listing.price}`,
    },
  });
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
