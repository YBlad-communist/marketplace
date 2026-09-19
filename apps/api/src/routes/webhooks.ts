import { Router } from 'express';
import { handleYookassaNotification } from '../services/paymentService.js';

const router: Router = Router();

/**
 * ВАЖНО: тело вебхука обрабатывается с rawBody, захваченным в app.ts
 * через express.raw({ verify: (req,_res,buf) => { req.rawBody = buf } }).
 * ЮKassa не подписывает уведомления: подлинность проверяется по IP из
 * аллоулиста и повторному GET статуса платежа (см. handleYookassaNotification).
 * Роутер смонтирован на POST /api/webhooks/yookassa, поэтому здесь '/' .
 */
router.post('/', async (req, res, next) => {
  try {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const result = await handleYookassaNotification(rawBody, req.ip);
    res.json({ received: true, handled: result.handled });
  } catch (err) {
    next(err);
  }
});

export default router;