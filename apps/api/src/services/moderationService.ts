import { prisma } from '@marketplace/db';
import { MODERATION_BLOCKED_KEYWORDS } from '@marketplace/shared';

export interface ModerationDecision {
  approve: boolean;
  reason?: string;
}

/**
 * Автоматическая модерация нового объявления.
 * Простейшая эвристика: базовая проверка запрещённого контента.
 * Полноценная проверка — через очередь + модераторов.
 */
export async function moderateListingContent(input: {
  title: string;
  description: string;
}): Promise<ModerationDecision> {
  const text = `${input.title}\n${input.description}`.toLowerCase();
  for (const word of MODERATION_BLOCKED_KEYWORDS) {
    if (text.includes(word)) {
      return { approve: false, reason: `Запрещённый контент: «${word}»` };
    }
  }
  if (/(https?:\/\/|www\.|t\.me\/|telegram)/i.test(text) && /(заработок|доход|казино|ставк)/i.test(text)) {
    return { approve: false, reason: 'Подозрение на спам/мошенничество: ссылки + финансовые обещания' };
  }
  return { approve: true };
}

export async function approveListing(listingId: string, moderatorId: string): Promise<void> {
  await prisma.listing.update({
    where: { id: listingId },
    data: { status: 'ACTIVE', moderationNote: null },
  });
  await prisma.report.updateMany({
    where: { targetId: listingId, targetType: 'LISTING', status: 'PENDING' },
    data: { status: 'RESOLVED', resolvedBy: moderatorId },
  });
}

export async function rejectListing(
  listingId: string,
  moderatorId: string,
  reason?: string
): Promise<void> {
  await prisma.listing.update({
    where: { id: listingId },
    data: { status: 'REJECTED', moderationNote: reason ?? 'Отклонено модератором' },
  });
  await prisma.report.updateMany({
    where: { targetId: listingId, targetType: 'LISTING', status: 'PENDING' },
    data: { status: 'RESOLVED', resolvedBy: moderatorId },
  });
}
