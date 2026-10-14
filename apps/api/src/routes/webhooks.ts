import { Router, Request, Response } from 'express';
import { getPaymentProvider } from '../services/payments/index.js';
import { handlePaymentWebhook } from '../services/paymentService.js';

const router: Router = Router();

/**
 * ВАЖНО: тело вебхука обрабатывается с rawBody, захваченным в app.ts
 * через express.raw({ verify: (req,_res,buf) => { req.rawBody = buf } }).
 * Подлинность уведомления (IP/подпись) проверяет сам провайдер
 * в handleWebhook (см. PaymentProvider). Роутер смонтирован на
 * POST/GET /api/webhooks/yookassa (путь не меняем — URL в кабинете провайдера
 * действует для всех провайдеров), поэтому здесь '/'.
 *
 * Монета Pay URL шлёт GET или POST query-параметрами и ждёт текст
 * SUCCESS/FAIL (или XML MNT_RESPONSE) — без JSON-обёртки.
 */
async function handle(req: Request, res: Response): Promise<void> {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const query = req.query as Record<string, string>;
  await handlePaymentWebhook(rawBody, req.ip, query);
  if (getPaymentProvider().name === 'moneta') {
    // docs.moneta.ru: подтверждение доставки уведомления — текст SUCCESS.
    res.status(200).type('text/plain').send('SUCCESS');
    return;
  }
  res.json({ received: true });
}

router.post('/', async (req, res, next) => {
  try {
    await handle(req, res);
  } catch (err) {
    next(err);
  }
});

// Монета может доставлять уведомления Pay URL и GET-запросом.
router.get('/', async (req, res, next) => {
  try {
    await handle(req, res);
  } catch (err) {
    next(err);
  }
});

export default router;
