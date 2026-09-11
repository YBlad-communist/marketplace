import { Router } from 'express';
import {
  conversationListSchema,
  createConversationSchema,
  messagesQuerySchema,
  sendMessageSchema,
  markReadSchema,
} from '@marketplace/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import {
  createConversation,
  getMessages,
  listConversations,
  markRead,
  createMessage,
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

router.post('/', authenticate, validate(createConversationSchema), async (req, res, next) => {
  try {
    const conversation = await createConversation({
      listingId: req.body.listingId,
      userId: req.userId!,
    });
    res.status(201).json({ data: { conversation } });
  } catch (err) {
    next(err);
  }
});

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
      text: req.body.text,
    });
    res.status(201).json({ data: { message } });
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
