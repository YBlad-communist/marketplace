import { prisma } from './index.js';

/**
 * Единая чистка протухших/отозванных токенов и использованных кодов.
 * Используется и API, и worker'ом — правки вносить только здесь.
 */
export async function cleanupExpiredTokens(): Promise<{ refreshTokens: number; codes: number }> {
  const [refreshTokens, codes] = await Promise.all([
    prisma.refreshTokenFamily.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }] },
    }),
    prisma.verificationCode.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { consumedAt: { not: null } }] },
    }),
  ]);
  return { refreshTokens: refreshTokens.count, codes: codes.count };
}
