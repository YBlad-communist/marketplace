import { prisma } from '@marketplace/db';
import { MODERATION_BLOCKED_KEYWORDS } from '@marketplace/shared';

interface ModerationJobData {
  listingId: string;
}

const PROHIBITED: readonly string[] = MODERATION_BLOCKED_KEYWORDS;

/** Автоматическая модерация нового объявления из очереди. */
export async function moderateListingJob(data: ModerationJobData): Promise<void> {
  const listing = await prisma.listing.findUnique({ where: { id: data.listingId } });
  if (!listing) return;

  const text = `${listing.title}\n${listing.description}`.toLowerCase();
  const banned = PROHIBITED.find((w) => text.includes(w));

  if (banned) {
    // Атомарно отклоняем только объявления без активной сделки: асинхронная
    // повторная модерация (по жалобе, с задержкой) не должна задним числом
    // зарезать уже RESERVED/SOLD позицию — это сломало бы идущий эскроу.
    const rejected = await prisma.listing.updateMany({
      where: { id: listing.id, status: { in: ['PENDING', 'ACTIVE'] } },
      data: { status: 'REJECTED', moderationNote: `Запрещённый контент: «${banned}»` },
    });
    if (rejected.count === 0) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { moderationNote: `Запрещённый контент: «${banned}»` },
      });
    }
  } else if (listing.status === 'PENDING') {
    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: 'ACTIVE' },
    });
  }
}
