import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { requireStripe } from '../config/stripe';
import { requireAuth } from '../middleware/auth';
import { Plan } from '../entities/Plan';
import { User } from '../entities/User';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { auditSubscription, recordStripeInvoice, syncStripeInvoices, upsertLocalSubscription } from '../services/stripe-billing';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

function nextCalendarMonth(from = new Date()) {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}

async function getOrCreateStripeCustomer(user: User) {
  const stripe = requireStripe();
  const userRepo = AppDataSource.getRepository(User);
  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.companyName || user.name,
    metadata: { userId: user.id },
  });
  user.stripeCustomerId = customer.id;
  await userRepo.save(user);
  return customer.id;
}

const checkoutSchema = z.object({
  planId: z.string().uuid(),
});

subscriptionsRouter.post('/checkout', async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Dados inválidos.', issues: parsed.error.flatten() });

  try {
    const stripe = requireStripe();
  const user = await AppDataSource.getRepository(User).findOneByOrFail({ id: req.auth!.sub });
  const plan = await AppDataSource.getRepository(Plan).findOne({ where: { id: parsed.data.planId, active: true } });
  if (!plan || !plan.stripePriceId || plan.monthlyPriceCents == null) {
    return res.status(400).json({ message: 'Plano indisponível para assinatura Stripe.' });
  }

  const existing = await AppDataSource.getRepository(Subscription).findOne({
    where: { user: { id: user.id }, status: SubscriptionStatus.ACTIVE },
  });
  if (existing) return res.status(409).json({ message: 'O usuário já possui uma assinatura ativa.' });

  const customerId = await getOrCreateStripeCustomer(user);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    success_url: `${env.frontendUrl}/confirmacao?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.frontendUrl}/checkout`,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    subscription_data: {
      metadata: { userId: user.id, planId: plan.id },
    },
    metadata: { userId: user.id, planId: plan.id },
  });

  res.json({
    url: session.url,
    nextBillingDate: nextCalendarMonth().toISOString(),
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao criar checkout Stripe.';
    return res.status(400).json({ message });
  }
});

subscriptionsRouter.get('/confirm', async (req, res) => {
  const sessionId = z.string().startsWith('cs_').safeParse(req.query.sessionId);
  if (!sessionId.success) return res.status(400).json({ message: 'Sessão Stripe inválida.' });

  const stripe = requireStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId.data, {
    expand: ['subscription', 'subscription.default_payment_method'],
  });
  if (session.metadata?.userId !== req.auth!.sub) {
    return res.status(403).json({ message: 'Sessão não pertence a este usuário.' });
  }
  if (session.status !== 'complete') {
    return res.status(402).json({ message: 'Pagamento ainda não confirmado.' });
  }

  const planId = session.metadata?.planId;
  if (!planId) return res.status(400).json({ message: 'Sessão sem plano.' });
  const user = await AppDataSource.getRepository(User).findOneByOrFail({ id: req.auth!.sub });
  const plan = await AppDataSource.getRepository(Plan).findOneByOrFail({ id: planId });
  const stripeSubscription = session.subscription as Stripe.Subscription;
  const pm = stripeSubscription.default_payment_method;
  const card = typeof pm === 'object' && pm && 'card' in pm ? pm.card : undefined;

  const subscription = await upsertLocalSubscription({
    user,
    plan,
    stripeSubscription,
    paymentMethod: {
      stripeId: typeof pm === 'string' ? pm : pm?.id,
      brand: card?.brand,
      last4: card?.last4,
    },
  });
  await syncStripeInvoices(subscription);
  await auditSubscription(user.id, subscription.id, 'SUBSCRIPTION_CREATED');

  res.json({
    subscription,
    nextBillingDate: subscription.currentPeriodEnd,
  });
});

subscriptionsRouter.get('/me', async (req, res) => {
  const subscription = await AppDataSource.getRepository(Subscription).findOne({
    where: { user: { id: req.auth!.sub } },
    order: { createdAt: 'DESC' },
  });
  if (!subscription) return res.status(404).json({ message: 'Nenhuma assinatura encontrada.' });
  res.json(subscription);
});

subscriptionsRouter.post('/:id/cancel', async (req, res) => {
  const stripe = requireStripe();
  const repo = AppDataSource.getRepository(Subscription);
  const subscription = await repo.findOne({ where: { id: req.params.id, user: { id: req.auth!.sub } } });
  if (!subscription) return res.status(404).json({ message: 'Assinatura não encontrada.' });

  if (subscription.gatewaySubscriptionId) {
    await stripe.subscriptions.update(subscription.gatewaySubscriptionId, { cancel_at_period_end: true });
  }
  subscription.status = SubscriptionStatus.CANCELLED;
  subscription.cancelledAt = new Date();
  await repo.save(subscription);
  await auditSubscription(req.auth!.sub, subscription.id, 'SUBSCRIPTION_CANCELLED');
  res.json(subscription);
});

export async function applyStripeInvoice(stripeInvoice: Stripe.Invoice) {
  const parent = stripeInvoice as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
    parent?: { subscription_details?: { subscription?: string } };
  };
  const stripeSubscriptionId = typeof parent.subscription === 'string'
    ? parent.subscription
    : parent.subscription?.id || parent.parent?.subscription_details?.subscription;
  if (!stripeSubscriptionId) return;
  const subscription = await AppDataSource.getRepository(Subscription).findOne({
    where: { gatewaySubscriptionId: stripeSubscriptionId },
  });
  if (!subscription) return;
  await recordStripeInvoice(stripeInvoice, subscription);
}
