import Stripe from 'stripe';
import { AppDataSource } from '../config/data-source';
import { stripe } from '../config/stripe';
import { Plan } from '../entities/Plan';
import { User } from '../entities/User';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { PaymentAttempt, PaymentAttemptStatus } from '../entities/PaymentAttempt';
import { PaymentMethod, PaymentMethodType } from '../entities/PaymentMethod';
import { audit } from './audit';

function billingPeriod(subscription: Stripe.Subscription) {
  const item = subscription.items.data[0] as (Stripe.SubscriptionItem & {
    current_period_start?: number;
    current_period_end?: number;
  }) | undefined;
  const raw = subscription as Stripe.Subscription & {
    current_period_start?: number;
    current_period_end?: number;
  };
  const startUnix = raw.current_period_start ?? item?.current_period_start ?? subscription.start_date;
  const endUnix = raw.current_period_end ?? item?.current_period_end ?? startUnix;
  return {
    start: new Date(startUnix * 1000),
    end: new Date(endUnix * 1000),
  };
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  if (status === 'active' || status === 'trialing') return SubscriptionStatus.ACTIVE;
  if (status === 'past_due' || status === 'unpaid') return SubscriptionStatus.PAST_DUE;
  if (status === 'canceled' || status === 'incomplete_expired') return SubscriptionStatus.CANCELLED;
  if (status === 'incomplete' || status === 'paused') return SubscriptionStatus.PENDING;
  return SubscriptionStatus.PAYMENT_FAILED;
}

function paymentDetailsFromStripe(params: {
  stripeSubscription: Stripe.Subscription;
  paymentMethod?: { brand?: string | null; last4?: string | null; stripeId?: string | null; type?: PaymentMethodType };
}) {
  const fallbackType = params.stripeSubscription.metadata?.paymentMethodType === 'PIX_RECURRING'
    ? PaymentMethodType.PIX_RECURRING
    : PaymentMethodType.CREDIT_CARD;
  if (params.paymentMethod?.stripeId || params.paymentMethod?.type) {
    return {
      stripeId: params.paymentMethod.stripeId ?? null,
      brand: params.paymentMethod.brand ?? null,
      last4: params.paymentMethod.last4 ?? null,
      type: params.paymentMethod.type ?? fallbackType,
    };
  }

  const pm = params.stripeSubscription.default_payment_method;
  if (!pm || typeof pm === 'string') {
    return { stripeId: typeof pm === 'string' ? pm : null, brand: null, last4: null, type: fallbackType };
  }

  const isPix = (pm as { type?: string }).type === 'pix';
  const card = 'card' in pm ? pm.card : undefined;
  return {
    stripeId: pm.id,
    brand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    type: isPix ? PaymentMethodType.PIX_RECURRING : fallbackType,
  };
}

export async function upsertLocalSubscription(params: {
  user: User;
  plan: Plan;
  stripeSubscription: Stripe.Subscription;
  paymentMethod?: { brand?: string | null; last4?: string | null; stripeId?: string | null; type?: PaymentMethodType };
}) {
  const { user, plan, stripeSubscription } = params;
  const paymentMethod = paymentDetailsFromStripe(params);
  const { start: periodStart, end: periodEnd } = billingPeriod(stripeSubscription);
  const status = mapStripeStatus(stripeSubscription.status);

  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  let subscription = await subscriptionRepo.findOne({
    where: { gatewaySubscriptionId: stripeSubscription.id },
  });
  if (!subscription) {
    subscription = subscriptionRepo.create({
      user,
      plan,
      gatewayCustomerId: typeof stripeSubscription.customer === 'string'
        ? stripeSubscription.customer
        : stripeSubscription.customer.id,
      gatewaySubscriptionId: stripeSubscription.id,
    });
  }

  subscription.user = user;
  subscription.plan = plan;
  subscription.status = status;
  subscription.startedAt = status === SubscriptionStatus.ACTIVE ? periodStart : subscription.startedAt;
  subscription.currentPeriodStart = periodStart;
  subscription.currentPeriodEnd = periodEnd;
  if (stripeSubscription.canceled_at) {
    subscription.cancelledAt = new Date(stripeSubscription.canceled_at * 1000);
  } else if (stripeSubscription.cancel_at_period_end) {
    subscription.cancelledAt = subscription.cancelledAt ?? new Date();
  } else {
    subscription.cancelledAt = null;
  }
  subscription.gatewayCustomerId = typeof stripeSubscription.customer === 'string'
    ? stripeSubscription.customer
    : stripeSubscription.customer.id;
  subscription.gatewaySubscriptionId = stripeSubscription.id;
  await subscriptionRepo.save(subscription);

  if (paymentMethod?.stripeId) {
    const pmRepo = AppDataSource.getRepository(PaymentMethod);
    const existing = await pmRepo.findOne({ where: { providerPaymentMethodId: paymentMethod.stripeId } });
    if (!existing) {
      await pmRepo.save(pmRepo.create({
        user,
        type: paymentMethod.type,
        provider: 'stripe',
        providerPaymentMethodId: paymentMethod.stripeId,
        cardBrand: paymentMethod.brand ?? null,
        cardLastFour: paymentMethod.last4 ?? null,
        active: true,
      }));
    }
  }

  return subscription;
}

export async function syncStripeInvoices(subscription: Subscription) {
  if (!subscription.gatewaySubscriptionId || !stripe) return;

  const list = await stripe.invoices.list({
    subscription: subscription.gatewaySubscriptionId,
    limit: 24,
  });
  for (const invoice of list.data) {
    await recordStripeInvoice(invoice, subscription);
  }
}

export async function syncAllStripeInvoices(limit = 100) {
  if (!stripe) return;
  const subscriptions = await AppDataSource.getRepository(Subscription).find({ take: limit });
  for (const subscription of subscriptions) {
    if (!subscription.gatewaySubscriptionId) continue;
    try {
      await syncStripeInvoices(subscription);
    } catch (error) {
      console.error(`Falha ao sincronizar faturas Stripe (${subscription.id}):`, error);
    }
  }
}

export async function recordStripeInvoice(stripeInvoice: Stripe.Invoice, subscription: Subscription) {
  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const existing = await invoiceRepo.findOne({ where: { gatewayInvoiceId: stripeInvoice.id } });
  const previousStatus = existing?.status;
  const paid = stripeInvoice.status === 'paid';
  const open = stripeInvoice.status === 'open' || stripeInvoice.status === 'draft';
  const invoice = existing ?? invoiceRepo.create({
    subscription,
    gatewayInvoiceId: stripeInvoice.id ?? null,
  });
  invoice.subscription = subscription;
  invoice.amountCents = stripeInvoice.amount_paid || stripeInvoice.amount_due || 0;
  invoice.status = paid ? InvoiceStatus.PAID : open ? InvoiceStatus.PENDING : InvoiceStatus.FAILED;
  invoice.dueDate = stripeInvoice.due_date
    ? new Date(stripeInvoice.due_date * 1000)
    : new Date(stripeInvoice.created * 1000);
  invoice.paidAt = paid && stripeInvoice.status_transitions.paid_at
    ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
    : paid ? new Date() : null;
  invoice.gatewayInvoiceId = stripeInvoice.id ?? null;
  await invoiceRepo.save(invoice);

  const shouldLogAttempt =
    (paid && previousStatus !== InvoiceStatus.PAID)
    || (!paid && !open && previousStatus !== InvoiceStatus.FAILED);
  if (!shouldLogAttempt) return;

  const attemptRepo = AppDataSource.getRepository(PaymentAttempt);
  await attemptRepo.save(attemptRepo.create({
    invoice,
    status: paid ? PaymentAttemptStatus.APPROVED : PaymentAttemptStatus.DECLINED,
    failureCode: paid ? null : (stripeInvoice.status ?? null),
    failureMessage: paid ? null : 'Falha na cobrança Stripe.',
  }));
}

export async function auditSubscription(userId: string, subscriptionId: string, action: string) {
  await audit({ actorUserId: userId, action, entity: 'Subscription', entityId: subscriptionId, metadata: { provider: 'stripe' } });
}
