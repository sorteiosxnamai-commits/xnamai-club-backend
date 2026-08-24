import { Router } from 'express';
import { AppDataSource } from '../config/data-source';
import { requireAuth } from '../middleware/auth';
import { Subscription } from '../entities/Subscription';
import { Invoice } from '../entities/Invoice';
import { PaymentMethod } from '../entities/PaymentMethod';

export const customerRouter = Router();
customerRouter.use(requireAuth);

customerRouter.get('/dashboard', async (req, res) => {
  const subscription = await AppDataSource.getRepository(Subscription).findOne({ where: { user: { id: req.auth!.sub } }, order: { createdAt: 'DESC' } });
  const paymentMethod = await AppDataSource.getRepository(PaymentMethod).findOne({ where: { user: { id: req.auth!.sub }, active: true }, order: { createdAt: 'DESC' } });
  const invoices = subscription
    ? await AppDataSource.getRepository(Invoice).find({ where: { subscription: { id: subscription.id } }, order: { createdAt: 'DESC' }, take: 10 })
    : [];

  res.json({ subscription, paymentMethod, invoices });
});
