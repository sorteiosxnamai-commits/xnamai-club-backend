import 'reflect-metadata';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AppDataSource } from './config/data-source';
import { env } from './config/env';
import { seedInitialData } from './services/seed';
import { ensureStripeWebhookEndpoint } from './services/register-stripe-webhook';
import { authRouter } from './routes/auth';
import { plansRouter } from './routes/plans';
import { subscriptionsRouter } from './routes/subscriptions';
import { customerRouter } from './routes/customer';
import { adminRouter } from './routes/admin';
import { webhooksRouter } from './routes/webhooks';

async function bootstrap() {
  await AppDataSource.initialize();
  await seedInitialData();
  await ensureStripeWebhookEndpoint();

  const app = express();
  app.use(cors({ origin: env.frontendUrl }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'xnamai-club-backend' }));
  app.use('/api/auth', authRouter);
  app.use('/api/plans', plansRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/me', customerRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/webhooks', webhooksRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ message: 'Erro interno do servidor.' });
  });

  app.listen(env.port, '0.0.0.0', () => console.log(`XNaMai Club API em 0.0.0.0:${env.port}`));
}

bootstrap().catch((error) => {
  console.error('Falha ao iniciar API:', error);
  process.exit(1);
});
