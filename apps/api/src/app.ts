import express, { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, isProd } from './config.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import categoryRoutes from './routes/categories.js';
import listingRoutes from './routes/listings.js';
import conversationRoutes from './routes/conversations.js';
import orderRoutes from './routes/orders.js';
import webhookRoutes from './routes/webhooks.js';
import uploadRoutes from './routes/uploads.js';
import reviewRoutes from './routes/reviews.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // За nginx/Cloudflare req.ip без этой настройки возвращает адрес прокси:
  // все rate limit'ы схлопывались бы в одну корзину, а security-логи и IP
  // сессий показывали бы не клиента. Число хопов (не true): Express берёт
  // правый адрес из X-Forwarded-For (добавлен доверенным прокси), левые
  // подделки игнорируются.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  if (isProd) {
    app.use(
      helmet({
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'"],
          },
        },
      })
    );
  } else {
    app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  }

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || env.CORS_ORIGINS.includes(origin)) {
          cb(null, true);
        } else {
          cb(new Error('Origin not allowed'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    })
  );

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/healthz' },
    })
  );

  app.use(compression());
  app.use(cookieParser());

  app.post(
    '/api/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '1mb', verify: captureRawBody }),
    webhookRoutes
  );

  app.use(
    express.json({
      limit: '256kb',
      verify: captureRawBody,
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/listings', listingRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/reviews', reviewRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(notFoundHandler);

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof Error && err.message === 'Origin not allowed') {
      logger.warn({ origin: req.headers.origin, ip: req.ip }, 'cors blocked origin');
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Origin not allowed' } });
    }
    next(err);
  });

  app.use(errorHandler);

  return app;
}

function captureRawBody(req: Request, _res: Response, buf: Buffer) {
  (req as Request & { rawBody?: Buffer }).rawBody = buf;
}
