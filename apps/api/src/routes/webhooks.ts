import { Router } from 'express';
import { handleStripeWebhook } from '../services/paymentService.js';

const router: Router = Router();

/**
 * ВАЖНО: тело вебхука обрабатывается с rawBody, захваченным в app.ts
 * через express.raw({ verify: (req,_res,buf) => { req.rawBody = buf } }).
 * Stripe требует подпись от исходного (неизменённого) тела запроса.
 * Роутер смонтирован на POST /api/webhooks/stripe, поэтому здесь '/' .
 */
router.post('/', async (req, res, next) => {
  try {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature = req.headers['stripe-signature'] as string | undefined;
    const result = await handleStripeWebhook(rawBody, signature);
    res.json({ received: true, handled: result.handled });
  } catch (err) {
    next(err);
  }
});

export default router;
