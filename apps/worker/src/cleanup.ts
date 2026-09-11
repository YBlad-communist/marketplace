import { prisma } from '@marketplace/db';

export async function cleanupExpiredTokens(): Promise<void> {
  await prisma.refreshTokenFamily.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }] },
  });
  await prisma.verificationCode.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { consumedAt: { not: null } }] },
  });
}
