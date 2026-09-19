import { Redis } from 'ioredis';
import { prisma } from '@marketplace/db';
import { env } from './config.js';
import { logger, sendEmail } from './mailer.js';

const msgCountKey = (receiverId: string, conversationId: string) => `offline:msgcount:${receiverId}:${conversationId}`;

/**
 * Дайджест-письмо: агрегирует офлайн-сообщения из одного диалога за окно
 * OFFLINE_EMAIL_COOLDOWN_MS. Вызывается отложенной BullMQ-джобой из socket.ts.
 *
 * Идемпотентность: джоба идёт с jobId = offline-digest-{receiver}-{conv},
 * поэтому повторный вызов (ретрай BullMQ) не дублирует письмо — счётчик
 * читается и сразу удаляется в одной операции (GETDEL), а без счётчика
 * письмо не отправляется.
 */
export async function sendOfflineDigest(
  payload: { receiverId?: unknown; conversationId?: unknown }
): Promise<{ sent: number }> {
  const receiverId = typeof payload?.receiverId === 'string' ? payload.receiverId : '';
  const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
  if (!receiverId || !conversationId) throw new Error('invalid offline digest payload');

  const redis = getDigestRedis();
  const key = msgCountKey(receiverId, conversationId);
  const count = await redis.getdel(key);
  const nWithNew = count === null ? 0 : Number(count);

  if (nWithNew <= 0) {
    // Письмо уже ушло более ранним прогоном джобы (ретрай) — ничего не делаем.
    return { sent: 0 };
  }

  // За окно пользователь мог сам зайти в диалог и прочитать сообщения:
  // дайджест не навязчив, если он снова онлайн — просто выбрасываем накопленное.
  if ((await redis.exists(`ws:presence:${receiverId}`)) === 1) {
    return { sent: 0 };
  }

  const user = await prisma.user.findUnique({
    where: { id: receiverId },
    select: { email: true, name: true },
  });
  if (!user?.email) return { sent: 0 };

  await sendEmail({
    to: user.email,
    subject: `У вас ${nWithNew} новых сообщений в Marketplace`,
    template: 'new-message',
    templateData: { name: user.name, preview: `У вас ${nWithNew} новых сообщений` },
    text: `Пока вас не было в сети, в диалоге появилось ${nWithNew} новых сообщений.`,
  });
  logger.info({ receiverId, conversationId, count: nWithNew }, 'offline digest sent');
  return { sent: 1 };
}

let digestRedis: Redis | null = null;

function getDigestRedis(): Redis {
  // Без lazyConnect: первый же вызов команды сам поднимет соединение,
  // а синглтон переживает все вызовы джобы в рамках процесса worker'a.
  if (!digestRedis) digestRedis = new Redis(env.REDIS_URL);
  return digestRedis;
}