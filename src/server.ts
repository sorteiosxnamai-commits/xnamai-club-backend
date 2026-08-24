import 'reflect-metadata';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AppDataSource } from './config/data-source';
import { seedInitialData } from './services/seed';
import { authRouter } from './routes/auth';
import { plansRouter } from './routes/plans';
import { subscriptionsRouter } from './routes/subscriptions';
import { customerRouter } from './routes/customer';
import { adminRouter } from './routes/admin';
import { webhooksRouter } from './routes/webhooks';

async function bootstrap() {
  await AppDataSource.initialize();
  await seedInitialData();

  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
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

  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`XNaMai Club API em http://localhost:${port}`));
}

bootstrap().catch((error) => {
  console.error('Falha ao iniciar API:', error);
  process.exit(1);
});
