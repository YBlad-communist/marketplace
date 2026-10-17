import { Router } from 'express';
import { imagePresignSchema } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { userRateLimit } from '../middleware/rateLimit.js';
import { createPresignedUpload } from '../lib/s3.js';
import { getRedis } from '../lib/redis.js';

const router: Router = Router();

/**
 * Выдача presigned URL для фото (объявление/аватар/чат — scope изолирует
 * сеты в Redis). П.22 аудита: не больше 30 выдач в час на пользователя —
 * иначе можно накручивать объекты в бакете.
 */
router.post(
  '/images/presign',
  authenticate,
  userRateLimit('uploads:presign', 60 * 60 * 1000, 30),
  validate(imagePresignSchema),
  async (req, res, next) => {
    try {
      const { mime, extension, sizeBytes, scope } = req.body;
      const presign = await createPresignedUpload(mime, extension, sizeBytes);
      const redis = getRedis();
      // Чат живёт в отдельном сете: создание листинга делает DEL всего
      // presign-сета пользователя и сносило бы чат-ключи вместе с ним.
      const setKey = scope === 'chat' ? `presign:chat:user:${req.userId}` : `presign:user:${req.userId}`;
      await redis.sadd(setKey, presign.key);
      await redis.expire(setKey, 60 * 15);
      res.json({ data: presign });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
