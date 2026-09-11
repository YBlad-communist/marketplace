import { Router } from 'express';
import { imagePresignSchema } from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { createPresignedUpload } from '../lib/s3.js';
import { getRedis } from '../lib/redis.js';

const router: Router = Router();

/** Выдача presigned URL для фото нового объявления (до создания listing). */
router.post('/images/presign', authenticate, validate(imagePresignSchema), async (req, res, next) => {
  try {
    const { mime, extension, sizeBytes } = req.body;
    const presign = await createPresignedUpload(mime, extension, sizeBytes);
    const redis = getRedis();
    await redis.sadd(`presign:user:${req.userId}`, presign.key);
    await redis.expire(`presign:user:${req.userId}`, 60 * 15);
    res.json({ data: presign });
  } catch (err) {
    next(err);
  }
});

export default router;
