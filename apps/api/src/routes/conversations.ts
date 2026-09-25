import { Router } from 'express';
import {
  conversationListSchema,
  createConversationSchema,
  messagesQuerySchema,
  sendMessageSchema,
  editMessageSchema,
  markReadSchema,
} from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { ipRateLimit } from '../middleware/rateLimit.js';
import { getIO } from '../lib/socket.js';
import { enqueueS3Delete } from '../services/notificationService.js';
import {
  createConversation,
  getMessages,
  listConversations,
  markRead,
  createMessage,
  editMessage,
  deleteMessage,
  deleteConversation,
} from '../services/conversationService.js';

const router: Router = Router();

router.get('/', authenticate, validate(conversationListSchema, 'query'), async (req, res, next) => {
  try {
    const result = await listConversations(req.userId!, req.query.cursor as string | undefined, Number(req.query.limit ?? 20));
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  authenticate,
  // Не дать заскриптовать массовое создание диалогов (спам/харассмент):
  // не больше 10 новых диалогов в минуту с одного IP.
  ipRateLimit('conversations:create', 60_000, 10),
  validate(createConversationSchema),
  async (req, res, next) => {
    try {
      const conversation = await createConversation({
        listingId: req.body.listingId,
        recipientId: req.body.recipientId,
        userId: req.userId!,
      });
      res.status(201).json({ data: { conversation } });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id/messages', authenticate, validate(messagesQuerySchema, 'query'), async (req, res, next) => {
  try {
    const result = await getMessages(
      req.params.id,
      req.userId!,
      req.query.cursor as string | undefined,
      Number(req.query.limit ?? 50)
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages', authenticate, validate(sendMessageSchema), async (req, res, next) => {
  try {
    const message = await createMessage({
      conversationId: req.params.id,
      userId: req.userId!,
      text: req.body.text ?? '',
      imageKey: req.body.imageKey,
    });
    res.status(201).json({ data: { message } });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/messages/:messageId', authenticate, validate(editMessageSchema), async (req, res, next) => {
  try {
    const message = await editMessage(req.params.id, req.params.messageId, req.userId!, req.body.text);
    // В тестах сокет не инициализирован — эмитт best-effort.
    try {
      getIO().to(`room:${req.params.id}`).emit('message:edited', message);
    } catch {
      // ignore
    }
    res.json({ data: { message } });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/messages/:messageId', authenticate, async (req, res, next) => {
  try {
    await deleteMessage(req.params.id, req.params.messageId, req.userId!);
    try {
      getIO().to(`room:${req.params.id}`).emit('message:deleted', {
        conversationId: req.params.id,
        messageId: req.params.messageId,
      });
    } catch {
      // ignore
    }
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { participantIds, imageKeys } = await deleteConversation(req.params.id, req.userId!);
    try {
      const io = getIO();
      io.to(`room:${req.params.id}`).emit('conversation:deleted', { conversationId: req.params.id });
      for (const otherId of participantIds.filter((p) => p !== req.userId)) {
        io.to(`user:${otherId}`).emit('conversation:deleted', { conversationId: req.params.id });
      }
    } catch {
      // ignore
    }
    if (imageKeys.length > 0) {
      await enqueueS3Delete(imageKeys).catch(() => undefined);
    }
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', authenticate, validate(markReadSchema), async (req, res, next) => {
  try {
    await markRead(req.params.id, req.userId!);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
