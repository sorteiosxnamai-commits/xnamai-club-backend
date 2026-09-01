import 'reflect-metadata';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AppDataSource, initializeDatabase } from './config/data-source';
import { env } from './config/env';
import { seedInitialData } from './services/seed';
import { ensureStripeWebhookEndpoint } from './services/register-stripe-webhook';
import { authRouter } from './routes/auth';
import { plansRouter } from './routes/plans';
import { subscriptionsRouter } from './routes/subscriptions';
import { customerRouter } from './routes/customer';
import { adminRouter } from './routes/admin';
import { webhooksRouter, stripeWebhookHandler } from './routes/webhooks';

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/$/, '');
}

function originVariants(value: string): string[] {
  const origin = normalizeOrigin(value);
  if (!origin) return [];
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
      return [url.origin];
    }
    const hosts = new Set([url.hostname]);
    if (url.hostname.startsWith('www.')) {
      hosts.add(url.hostname.slice(4));
    } else {
      hosts.add(`www.${url.hostname}`);
    }
    return [...hosts].map((hostname) => {
      const next = new URL(url.href);
      next.hostname = hostname;
      return next.origin;
    });
  } catch {
    return [origin];
  }
}

async function bootstrap() {
  const app = express();
  const extraOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowedOrigins = [...new Set([
    ...originVariants(env.frontendUrl),
    'http://localhost:5173',
    'https://xnamai-club-frontend.vercel.app',
    'https://www.clubxnamai.com.br',
    'https://clubxnamai.com.br',
    ...extraOrigins.flatMap(originVariants),
  ])];
  console.log('CORS origins:', allowedOrigins.join(', '));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, origin || allowedOrigins[0]);
        return;
      }
      console.warn(`CORS blocked origin: ${origin}`);
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'xnamai-club-backend',
      database: AppDataSource.isInitialized,
    });
  });
  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/plans', plansRouter);
  api.use('/subscriptions', subscriptionsRouter);
  api.use('/me', customerRouter);
  api.use('/admin', adminRouter);
  api.use('/webhooks', webhooksRouter);
  app.use('/api', api);
  app.use(api);

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erro interno do servidor.' });
    }
  });

  await new Promise<void>((resolve) => {
    app.listen(env.port, '0.0.0.0', () => {
      console.log(`XNaMai Club API em 0.0.0.0:${env.port}`);
      resolve();
    });
  });

  await initializeDatabase();
  await seedInitialData();
  try {
    await ensureStripeWebhookEndpoint();
  } catch (error) {
    console.error('Stripe: falha ao registrar webhook (API continua no ar).', error);
  }
}

bootstrap().catch((error) => {
  console.error('Falha ao iniciar API:', error);
  process.exit(1);
});
