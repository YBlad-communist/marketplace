import { Router } from 'express';
import { prisma } from '@marketplace/db';
import {
  usersMeUpdateSchema,
  phoneChangeRequestSchema,
  phoneChangeConfirmSchema,
  avatarConfirmSchema,
  AppError,
  errorCodes,
} from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { publicUser } from '../services/authService.js';
import { assertOtpSendAllowed, createVerificationCode, verifyCode } from '../services/verificationService.js';
import { enqueueSms } from '../services/notificationService.js';
import { deleteObject, verifyImageObject } from '../lib/s3.js';
import { processImage } from '../services/imageService.js';
import { getRedis } from '../lib/redis.js';

const router: Router = Router();

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
    res.json({ data: { user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

router.patch('/me', authenticate, validate(usersMeUpdateSchema), async (req, res, next) => {
  try {
    // Смена телефона — только через /me/phone/request + /me/phone/confirm
    // с подтверждением по SMS; PATCH phone молча игнорируется.
    const { phone: _ignored, ...rest } = req.body;
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: rest,
    });
    res.json({ data: { user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

router.post('/me/phone/request', authenticate, validate(phoneChangeRequestSchema), async (req, res, next) => {
  try {
    const { phone } = req.body;
    const exists = await prisma.user.findFirst({ where: { phone, id: { not: req.userId } } });
    if (exists) {
      throw new AppError(errorCodes.CONFLICT, 'Этот телефон уже занят', 409);
    }
    await assertOtpSendAllowed(phone, req.userId);
    const code = await createVerificationCode({
      userId: req.userId!,
      purpose: 'PHONE_VERIFY',
      channel: 'PHONE',
      target: phone,
    });
    await enqueueSms(phone, `Код для смены телефона: ${code}`);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/me/phone/confirm', authenticate, validate(phoneChangeConfirmSchema), async (req, res, next) => {
  try {
    const { phone, code } = req.body;
    await verifyCode({ userId: req.userId, purpose: 'PHONE_VERIFY', target: phone, code });
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { phone, phoneVerifiedAt: new Date() },
    });
    res.json({ data: { user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

router.post('/me/avatar/confirm', authenticate, validate(avatarConfirmSchema), async (req, res, next) => {
  try {
    const { key } = req.body;
    const redis = getRedis();
    const setKey = `presign:user:${req.userId}`;
    const isIssued = await redis.sismember(setKey, key);
    if (!isIssued) {
      throw new AppError(errorCodes.VALIDATION, 'Файл не был загружен через presigned URL', 400);
    }
    await redis.srem(setKey, key);
    await verifyImageObject(key);
    const processed = await processImage(key);
    await deleteObject(key);
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { avatarUrl: processed.publicUrl },
    });
    res.json({ data: { user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        city: true,
        rating: true,
        ratingCount: true,
        isVerified: true,
        createdAt: true,
      },
    });
    if (!user) throw new AppError(errorCodes.NOT_FOUND, 'Пользователь не найден', 404);
    res.json({ data: { user } });
  } catch (err) {
    next(err);
  }
});

export default router;
