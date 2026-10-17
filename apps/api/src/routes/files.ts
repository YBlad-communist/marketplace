import { Router } from 'express';
import type { Response } from 'express';
import { prisma } from '@marketplace/db';
import { AppError, errorCodes } from '@marketplace/shared';
import { optionalAuthenticate, isModeratorRole } from '../middleware/auth.js';
import { getObjectBuffer, headObject } from '../lib/s3.js';

/**
 * Приватная раздача файлов (п.20 аудита): анонимный download-policy бакета
 * убран, public-политика — только на префикс images/, поэтому картинки
 * отдаём через API с проверкой доступа:
 *  - фото чатов (chat/ + legacy-ключи в Message) — только участникам диалога;
 *  - фото споров (raw/) — покупателю, продавцу и модераторам;
 *  - остальные images/ (объявления, аватары) — публично.
 */
const router: Router = Router();

// images/ — обработанные фото объявлений/аватаров (публичные);
// chat/ — приватные фото сообщений; raw/ — загрузки (отдаются только
// если прикреплены к открытому спору). Любой другой путь — отказ.
const KEY_PATTERN = /^(images|chat|raw)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;

async function serveFile(res: Response, key: string, cacheControl: string): Promise<void> {
  const head = await headObject(key);
  if (!head) {
    throw new AppError(errorCodes.NOT_FOUND, 'Файл не найден', 404);
  }
  const buf = await getObjectBuffer(key);
  if (!buf) {
    throw new AppError(errorCodes.NOT_FOUND, 'Файл не найден', 404);
  }
  res.set({
    'Content-Type': head.contentType ?? 'application/octet-stream',
    'Content-Length': String(buf.length),
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

router.get('/*', optionalAuthenticate, async (req, res, next) => {
  try {
    const key = req.params[0] ?? '';
    if (!KEY_PATTERN.test(key)) {
      throw new AppError(errorCodes.FORBIDDEN, 'Доступ запрещён', 403);
    }

    // Фото сообщений (chat/ и legacy-ключи, лежащие в Message.imageKey*):
    // доступ только у участников диалога — независимо от префикса.
    const message = await prisma.message.findFirst({
      where: { OR: [{ imageKey: key }, { imageThumbKey: key }] },
      select: { conversation: { select: { participants: { select: { userId: true } } } } },
    });
    if (message) {
      if (!req.userId) {
        throw new AppError(errorCodes.UNAUTHORIZED, 'Требуется авторизация', 401);
      }
      const isParticipant = message.conversation.participants.some((p) => p.userId === req.userId);
      if (!isParticipant) {
        throw new AppError(errorCodes.FORBIDDEN, 'Нет доступа к файлу', 403);
      }
      return serveFile(res, key, 'private, no-store');
    }

    if (key.startsWith('images/')) {
      return serveFile(res, key, 'public, max-age=86400');
    }
    if (key.startsWith('chat/')) {
      // Приватный префикс, но сообщение с таким ключом не найдено —
      // не даём перебирать ключи.
      throw new AppError(errorCodes.FORBIDDEN, 'Нет доступа к файлу', 403);
    }

    // raw/: публично не отдаём; ключ может принадлежать фото споров —
    // доступ у сторон спора и модераторов.
    const dispute = await prisma.dispute.findFirst({
      where: { photos: { has: key } },
      select: { order: { select: { buyerId: true, listing: { select: { sellerId: true } } } } },
    });
    if (!dispute) {
      throw new AppError(errorCodes.FORBIDDEN, 'Нет доступа к файлу', 403);
    }
    if (!req.userId) {
      throw new AppError(errorCodes.UNAUTHORIZED, 'Требуется авторизация', 401);
    }
    const isParty =
      dispute.order.buyerId === req.userId || dispute.order.listing.sellerId === req.userId;
    if (!isParty && !(req.userRole && isModeratorRole(req.userRole))) {
      throw new AppError(errorCodes.FORBIDDEN, 'Нет доступа к файлу', 403);
    }
    return serveFile(res, key, 'private, no-store');
  } catch (err) {
    next(err);
  }
});

export default router;
