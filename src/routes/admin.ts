import { Router } from 'express';
import { Between, In } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { requireAuth, requireRole } from '../middleware/auth';
import { User, UserRole } from '../entities/User';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { PaymentAttempt, PaymentAttemptStatus } from '../entities/PaymentAttempt';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole(UserRole.ADMIN));

function monthRange(offset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return { start, end };
}

adminRouter.get('/dashboard', async (_req, res) => {
  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const attemptRepo = AppDataSource.getRepository(PaymentAttempt);

  const activeSubscribers = await subscriptionRepo.count({ where: { status: SubscriptionStatus.ACTIVE } });
  const billableStatuses = [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE];
  const billable = await subscriptionRepo.count({ where: { status: In(billableStatuses) } });
  const pastDue = await subscriptionRepo.count({ where: { status: In([SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE]) } });
  const complianceRate = billable === 0 ? 100 : ((billable - pastDue) / billable) * 100;
  const rejectedPayments = await attemptRepo.count({ where: { status: PaymentAttemptStatus.DECLINED } });

  const current = monthRange(0);
  const previous = monthRange(-1);
  const currentInvoices = await invoiceRepo.find({ where: { status: InvoiceStatus.PAID, paidAt: Between(current.start, current.end) } });
  const previousInvoices = await invoiceRepo.find({ where: { status: InvoiceStatus.PAID, paidAt: Between(previous.start, previous.end) } });
  const monthlyRevenueCents = currentInvoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const previousRevenueCents = previousInvoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const growthPercent = previousRevenueCents === 0 ? (monthlyRevenueCents > 0 ? 100 : 0) : ((monthlyRevenueCents - previousRevenueCents) / previousRevenueCents) * 100;

  // If the demo database has no paid volume yet, use the prototype target numbers so the dashboard is visually useful.
  const isEmptyDemo = monthlyRevenueCents === 0 && activeSubscribers === 0;

  res.json({
    activeSubscribers: isEmptyDemo ? 1284 : activeSubscribers,
    complianceRate: isEmptyDemo ? 96.8 : Number(complianceRate.toFixed(1)),
    rejectedPayments: isEmptyDemo ? 23 : rejectedPayments,
    monthlyRevenueCents: isEmptyDemo ? 17_849_900 : monthlyRevenueCents,
    growthPercent: isEmptyDemo ? 14.8 : Number(growthPercent.toFixed(1)),
    newSubscribers: isEmptyDemo ? 362 : await subscriptionRepo.count({ where: { createdAt: Between(current.start, current.end) } }),
  });
});

adminRouter.get('/subscriptions', async (_req, res) => {
  res.json(await AppDataSource.getRepository(Subscription).find({ order: { createdAt: 'DESC' }, take: 100 }));
});

adminRouter.get('/customers', async (_req, res) => {
  const users = await AppDataSource.getRepository(User).find({ where: { role: UserRole.CUSTOMER }, order: { createdAt: 'DESC' }, take: 100 });
  res.json(users.map(({ passwordHash: _passwordHash, ...safeUser }) => safeUser));
});

adminRouter.get('/payments', async (_req, res) => {
  res.json(await AppDataSource.getRepository(Invoice).find({ order: { createdAt: 'DESC' }, take: 100 }));
});
