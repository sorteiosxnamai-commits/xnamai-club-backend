import Stripe from 'stripe';
import { AppDataSource } from '../config/data-source';
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

export async function upsertLocalSubscription(params: {
  user: User;
  plan: Plan;
  stripeSubscription: Stripe.Subscription;
  paymentMethod?: { brand?: string | null; last4?: string | null; stripeId?: string | null };
}) {
  const { user, plan, stripeSubscription, paymentMethod } = params;
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
  subscription.cancelledAt = stripeSubscription.canceled_at
    ? new Date(stripeSubscription.canceled_at * 1000)
    : null;
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
        type: PaymentMethodType.CREDIT_CARD,
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

export async function recordStripeInvoice(stripeInvoice: Stripe.Invoice, subscription: Subscription) {
  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const existing = await invoiceRepo.findOne({ where: { gatewayInvoiceId: stripeInvoice.id } });
  const paid = stripeInvoice.status === 'paid';
  const invoice = existing ?? invoiceRepo.create({
    subscription,
    gatewayInvoiceId: stripeInvoice.id ?? null,
  });
  invoice.subscription = subscription;
  invoice.amountCents = stripeInvoice.amount_paid || stripeInvoice.amount_due || 0;
  invoice.status = paid ? InvoiceStatus.PAID : stripeInvoice.status === 'open' ? InvoiceStatus.PENDING : InvoiceStatus.FAILED;
  invoice.dueDate = stripeInvoice.due_date
    ? new Date(stripeInvoice.due_date * 1000)
    : new Date(stripeInvoice.created * 1000);
  invoice.paidAt = paid && stripeInvoice.status_transitions.paid_at
    ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
    : paid ? new Date() : null;
  invoice.gatewayInvoiceId = stripeInvoice.id ?? null;
  await invoiceRepo.save(invoice);

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
