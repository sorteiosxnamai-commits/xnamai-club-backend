import { Router } from 'express';
import { In } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { requireStripe } from '../config/stripe';
import { requireAuth } from '../middleware/auth';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice } from '../entities/Invoice';
import { PaymentMethod } from '../entities/PaymentMethod';
import { membershipAccess, pickPrimarySubscription } from '../services/membership-access';
import { reconcileUserPixPayments, syncStripeInvoices } from '../services/stripe-billing';

export const customerRouter = Router();
customerRouter.use(requireAuth);

customerRouter.get('/dashboard', async (req, res) => {
  try {
    await reconcileUserPixPayments(req.auth!.sub);
  } catch (error) {
    console.error('Falha ao reconciliar PIX do cliente:', error);
  }
  const subscriptions = await AppDataSource.getRepository(Subscription).find({
    where: { user: { id: req.auth!.sub } },
    order: { createdAt: 'ASC' },
  });
  const paymentMethod = await AppDataSource.getRepository(PaymentMethod).findOne({
    where: { user: { id: req.auth!.sub }, active: true },
    order: { createdAt: 'DESC' },
  });
  for (const row of subscriptions) {
    if (!row.gatewaySubscriptionId) continue;
    try {
      const current = await requireStripe().subscriptions.retrieve(row.gatewaySubscriptionId);
      if (current.status === 'canceled' || current.status === 'incomplete_expired') {
        row.status = SubscriptionStatus.CANCELLED;
        row.cancelledAt = row.cancelledAt ?? (current.canceled_at ? new Date(current.canceled_at * 1000) : new Date());
        await AppDataSource.getRepository(Subscription).save(row);
      }
    } catch (error) {
      console.error('Falha ao sincronizar cancelamento Stripe:', error);
    }
    try {
      await syncStripeInvoices(row);
    } catch (error) {
      console.error('Falha ao sincronizar faturas Stripe:', error);
    }
  }

  const subscriptionIds = subscriptions.map((row) => row.id);
  const paidAndOpen = subscriptionIds.length
    ? await AppDataSource.getRepository(Invoice).find({
      where: { subscription: { id: In(subscriptionIds) } },
      order: { createdAt: 'DESC' },
    })
    : [];
  const invoicesBySubscription = new Map(subscriptions.map((row) => [row.id, [] as Invoice[]]));
  for (const invoice of paidAndOpen) {
    const bucket = invoice.subscription?.id ? invoicesBySubscription.get(invoice.subscription.id) : undefined;
    if (bucket) bucket.push(invoice);
  }
  for (const row of subscriptions) {
    row.invoices = invoicesBySubscription.get(row.id) ?? [];
  }

  const subscription = pickPrimarySubscription(subscriptions) ?? null;
  const invoices = (subscription?.invoices ?? []).slice(0, 10);
  if (subscription) delete (subscription as { invoices?: Invoice[] }).invoices;

  res.json({
    subscription,
    paymentMethod,
    invoices,
    access: membershipAccess(subscription, invoices),
  });
});
