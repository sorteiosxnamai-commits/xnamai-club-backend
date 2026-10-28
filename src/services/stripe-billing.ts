import Stripe from 'stripe';
import { AppDataSource } from '../config/data-source';
import { requireStripe, stripe } from '../config/stripe';
import { Plan } from '../entities/Plan';
import { User } from '../entities/User';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { PaymentAttempt, PaymentAttemptStatus } from '../entities/PaymentAttempt';
import { PaymentMethod, PaymentMethodType } from '../entities/PaymentMethod';
import { audit } from './audit';

function billingPeriod(subscription: Stripe.Subscription) {
  const item = subscription.items?.data?.[0];
  const raw = subscription as Stripe.Subscription & {
    current_period_start?: number;
    current_period_end?: number;
  };
  const startUnix = raw.current_period_start ?? item?.current_period_start ?? subscription.start_date;
  let endUnix = raw.current_period_end ?? item?.current_period_end ?? 0;
  const start = new Date(startUnix * 1000);
  if (!endUnix || endUnix <= startUnix) endUnix = Math.floor(addCalendarMonth(start).getTime() / 1000);
  return { start, end: new Date(endUnix * 1000) };
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  if (status === 'active' || status === 'trialing') return SubscriptionStatus.ACTIVE;
  if (status === 'past_due' || status === 'unpaid') return SubscriptionStatus.PAST_DUE;
  if (status === 'canceled' || status === 'incomplete_expired') return SubscriptionStatus.CANCELLED;
  if (status === 'incomplete' || status === 'paused') return SubscriptionStatus.PENDING;
  return SubscriptionStatus.PAYMENT_FAILED;
}

function addCalendarMonth(from: Date) {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}

export const PIX_MONTH_PURPOSE = 'pix_month';
export const PIX_MONTH_PRICE_CENTS = 19997;

export function subscriptionToKeep<T extends { id: string; created: number }>(subscriptions: T[]) {
  if (subscriptions.length === 0) return null;
  return [...subscriptions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))[0] ?? null;
}

export async function findBlockingStripeSubscription(customerId: string) {
  const client = stripe || requireStripe();
  for (const status of ['active', 'trialing', 'past_due', 'unpaid'] as const) {
    const page = await client.subscriptions.list({ customer: customerId, status, limit: 5 });
    const found = page.data[0];
    if (found) return found;
  }
  return null;
}

export async function expireOpenSubscriptionCheckouts(customerId: string) {
  const client = stripe || requireStripe();
  const open = await client.checkout.sessions.list({
    customer: customerId,
    status: 'open',
    limit: 20,
  });
  for (const session of open.data) {
    if (session.mode !== 'subscription' || !session.id) continue;
    try {
      await client.checkout.sessions.expire(session.id);
    } catch (error) {
      console.error(`Falha ao expirar checkout Stripe ${session.id}:`, error);
    }
  }
}

async function refundLatestInvoice(subscription: Stripe.Subscription) {
  const client = stripe || requireStripe();
  const invoiceId = typeof subscription.latest_invoice === 'string'
    ? subscription.latest_invoice
    : subscription.latest_invoice?.id;
  if (!invoiceId) return;
  const invoice = await client.invoices.retrieve(invoiceId) as Stripe.Invoice & {
    payment_intent?: string | Stripe.PaymentIntent | null;
    charge?: string | Stripe.Charge | null;
  };
  if (invoice.status !== 'paid') return;
  const paymentIntentId = typeof invoice.payment_intent === 'string'
    ? invoice.payment_intent
    : invoice.payment_intent?.id;
  if (paymentIntentId) {
    await client.refunds.create({ payment_intent: paymentIntentId });
    return;
  }
  const chargeId = typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id;
  if (chargeId) await client.refunds.create({ charge: chargeId });
}

export async function enforceSingleActiveStripeSubscription(stripeSubscription: Stripe.Subscription) {
  const client = stripe || requireStripe();
  const customerId = typeof stripeSubscription.customer === 'string'
    ? stripeSubscription.customer
    : stripeSubscription.customer?.id;
  if (!customerId) return stripeSubscription;

  const active = await client.subscriptions.list({
    customer: customerId,
    status: 'active',
    limit: 20,
    expand: ['data.default_payment_method', 'data.latest_invoice'],
  });
  const keep = subscriptionToKeep(active.data);
  if (!keep || active.data.length <= 1) {
    return active.data.find((item) => item.id === stripeSubscription.id) || stripeSubscription;
  }

  for (const duplicate of active.data) {
    if (duplicate.id === keep.id) continue;
    try {
      await refundLatestInvoice(duplicate);
    } catch (error) {
      console.error(`Falha ao estornar assinatura duplicada ${duplicate.id}:`, error);
    }
    try {
      await client.subscriptions.cancel(duplicate.id);
      console.warn(`Assinatura Stripe duplicada cancelada: ${duplicate.id} (mantida ${keep.id})`);
    } catch (error) {
      console.error(`Falha ao cancelar assinatura duplicada ${duplicate.id}:`, error);
    }
  }

  if (keep.id === stripeSubscription.id) return stripeSubscription;
  return client.subscriptions.retrieve(keep.id, {
    expand: ['default_payment_method', 'latest_invoice'],
  });
}

export function pixCheckoutIsPaid(session: {
  mode?: string | null;
  status?: string | null;
  payment_status?: string | null;
  metadata?: { purpose?: string | null } | null;
}) {
  return session.mode === 'payment'
    && session.metadata?.purpose === PIX_MONTH_PURPOSE
    && session.status === 'complete'
    && session.payment_status === 'paid';
}

export function pixMonthWindow(
  paidAt: Date,
  current: { status?: string | null; currentPeriodStart?: Date | null; currentPeriodEnd?: Date | null },
) {
  const end = current.currentPeriodEnd ? new Date(current.currentPeriodEnd) : null;
  const covered = current.status === SubscriptionStatus.ACTIVE && Boolean(end && end.getTime() > paidAt.getTime());
  const periodStart = covered ? new Date(current.currentPeriodStart ?? paidAt) : paidAt;
  const periodEnd = addCalendarMonth(covered && end ? end : paidAt);
  return { periodStart, periodEnd };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function laterDate(a: Date, b: Date) {
  return a.getTime() >= b.getTime() ? a : b;
}

function monthLikeEnd(start: Date, end: Date) {
  return end.getTime() - start.getTime() >= WEEK_MS;
}

function paidInvoiceCoverage(stripeInvoice: Stripe.Invoice) {
  const paidUnix = stripeInvoice.status_transitions?.paid_at || stripeInvoice.created;
  const paidAt = new Date(paidUnix * 1000);
  const raw = stripeInvoice as Stripe.Invoice & { period_start?: number; period_end?: number };
  const line = stripeInvoice.lines?.data?.[0];
  const startUnix = line?.period?.start ?? raw.period_start;
  const endUnix = line?.period?.end ?? raw.period_end;
  const start = startUnix ? new Date(startUnix * 1000) : paidAt;
  let end = addCalendarMonth(paidAt);
  if (endUnix) {
    const invoiceEnd = new Date(endUnix * 1000);
    if (monthLikeEnd(start, invoiceEnd)) end = laterDate(end, invoiceEnd);
  }
  return { paidAt, start, end };
}

function paymentDetailsFromStripe(params: {
  stripeSubscription: Stripe.Subscription;
  paymentMethod?: { brand?: string | null; last4?: string | null; stripeId?: string | null; type?: PaymentMethodType };
}) {
  const fallbackType = params.stripeSubscription.metadata?.paymentMethodType === 'PIX_RECURRING'
    ? PaymentMethodType.PIX_RECURRING
    : PaymentMethodType.CREDIT_CARD;
  const pm = params.stripeSubscription.default_payment_method;
  if (pm && typeof pm !== 'string') {
    const pmType = pm.type;
    const card = pm.type === 'card' ? pm.card : undefined;
    const type = pmType === 'boleto'
      ? PaymentMethodType.BOLETO
      : pmType === 'pix'
        ? PaymentMethodType.PIX_RECURRING
        : pmType === 'card'
          ? PaymentMethodType.CREDIT_CARD
          : params.paymentMethod?.type ?? fallbackType;
    return {
      stripeId: pm.id,
      brand: type === PaymentMethodType.CREDIT_CARD ? card?.brand ?? null : null,
      last4: type === PaymentMethodType.CREDIT_CARD ? card?.last4 ?? null : null,
      type,
    };
  }

  if (params.paymentMethod?.stripeId || params.paymentMethod?.type) {
    return {
      stripeId: params.paymentMethod.stripeId ?? (typeof pm === 'string' ? pm : null),
      brand: params.paymentMethod.brand ?? null,
      last4: params.paymentMethod.last4 ?? null,
      type: params.paymentMethod.type ?? fallbackType,
    };
  }

  return { stripeId: typeof pm === 'string' ? pm : null, brand: null, last4: null, type: fallbackType };
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
  if (!subscription.startedAt && status === SubscriptionStatus.ACTIVE) subscription.startedAt = periodStart;
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
  const latestInvoice = stripeSubscription.latest_invoice;
  const paidLatest = latestInvoice && typeof latestInvoice !== 'string' && latestInvoice.status === 'paid'
    ? latestInvoice
    : null;
  await applyPaidPeriodAccess(subscription, paidLatest);

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
    } else {
      let changed = false;
      if (existing.type !== paymentMethod.type) {
        existing.type = paymentMethod.type;
        changed = true;
      }
      if (paymentMethod.brand && existing.cardBrand !== paymentMethod.brand) {
        existing.cardBrand = paymentMethod.brand;
        changed = true;
      }
      if (paymentMethod.last4 && existing.cardLastFour !== paymentMethod.last4) {
        existing.cardLastFour = paymentMethod.last4;
        changed = true;
      }
      if (!existing.active) {
        existing.active = true;
        changed = true;
      }
      if (changed) await pmRepo.save(existing);
    }
  }

  return subscription;
}

export async function applyPaidPeriodAccess(subscription: Subscription, stripeInvoice?: Stripe.Invoice | null) {
  const now = Date.now();
  let paidAt: Date | null = null;
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;

  if (stripeInvoice?.status === 'paid') {
    const coverage = paidInvoiceCoverage(stripeInvoice);
    paidAt = coverage.paidAt;
    periodStart = coverage.start;
    periodEnd = coverage.end;
  }

  if (!paidAt) {
    const local = await AppDataSource.getRepository(Invoice).findOne({
      where: { subscription: { id: subscription.id }, status: InvoiceStatus.PAID },
      order: { paidAt: 'DESC' },
    });
    if (local) {
      paidAt = local.paidAt ?? local.dueDate;
      periodStart = local.paidAt ?? local.dueDate;
      periodEnd = addCalendarMonth(paidAt);
    }
  }

  if (!paidAt && stripe && subscription.gatewaySubscriptionId) {
    const list = await stripe.invoices.list({
      subscription: subscription.gatewaySubscriptionId,
      status: 'paid',
      limit: 1,
    });
    if (list.data[0]) {
      const coverage = paidInvoiceCoverage(list.data[0]);
      paidAt = coverage.paidAt;
      periodStart = coverage.start;
      periodEnd = coverage.end;
    }
  }

  if (!paidAt || !periodEnd || periodEnd.getTime() <= now) return subscription;

  const stripePeriod = subscription.currentPeriodEnd;
  if (stripePeriod && periodStart && monthLikeEnd(periodStart, stripePeriod)) {
    periodEnd = laterDate(periodEnd, stripePeriod);
  }

  if (
    subscription.status === SubscriptionStatus.ACTIVE
    && subscription.currentPeriodEnd
    && subscription.currentPeriodEnd.getTime() >= periodEnd.getTime()
  ) {
    return subscription;
  }

  subscription.status = SubscriptionStatus.ACTIVE;
  subscription.startedAt = subscription.startedAt ?? periodStart ?? paidAt;
  subscription.currentPeriodStart = periodStart ?? paidAt;
  subscription.currentPeriodEnd = periodEnd;
  subscription.cancelledAt = null;
  return AppDataSource.getRepository(Subscription).save(subscription);
}

export async function repairPaidThroughSubscriptions(syncPayments = false) {
  const since = new Date();
  since.setDate(since.getDate() - 45);
  const rows = await AppDataSource.getRepository(Subscription)
    .createQueryBuilder('subscription')
    .leftJoin('subscription.invoices', 'invoice')
    .where('(subscription.status IN (:...statuses) OR subscription.currentPeriodEnd <= :now)', {
      statuses: [SubscriptionStatus.CANCELLED, SubscriptionStatus.PENDING],
      now: new Date(),
    })
    .andWhere('(invoice.status = :paid OR subscription.createdAt >= :since)', {
      paid: InvoiceStatus.PAID,
      since,
    })
    .getMany();

  let updated = 0;
  await mapPool(rows, 6, async (subscription) => {
    try {
      const before = subscription.status;
      // Canceled subscriptions are absent from Stripe's active subscription list.
      // Their old local paid invoice must not hide a renewal paid afterward.
      if (syncPayments && subscription.gatewaySubscriptionId) await syncStripeInvoices(subscription);
      const next = await applyPaidPeriodAccess(subscription);
      if (next.status !== before) updated += 1;
    } catch (error) {
      console.error(`Falha ao reativar período pago da assinatura ${subscription.id}:`, error);
    }
  });
  return updated;
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
  await applyPaidPeriodAccess(subscription);
}

async function mapPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const task = Promise.resolve()
      .then(() => worker(item))
      .finally(() => { executing.delete(task); });
    executing.add(task);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  await Promise.all(executing);
}

let stripeSyncRunning = false;
let stripeSyncAt = 0;

export async function syncRecentStripeSubscriptions(limit = 40) {
  const client = stripe;
  if (!client) return;

  const userRepo = AppDataSource.getRepository(User);
  const planRepo = AppDataSource.getRepository(Plan);
  const launchPlan = await planRepo.findOne({ where: { code: 'LAUNCH' } });
  const dedupedCustomers = new Set<string>();

  async function upsert(stripeSubscription: Stripe.Subscription) {
    const customerId = typeof stripeSubscription.customer === 'string'
      ? stripeSubscription.customer
      : stripeSubscription.customer?.id;
    let kept = stripeSubscription;
    if (customerId && !dedupedCustomers.has(customerId)) {
      dedupedCustomers.add(customerId);
      kept = await enforceSingleActiveStripeSubscription(stripeSubscription);
    } else if (customerId && stripeSubscription.status === 'active') {
      const stillActive = await requireStripe().subscriptions.retrieve(stripeSubscription.id, {
        expand: ['default_payment_method', 'latest_invoice'],
      });
      if (stillActive.status !== 'active') return;
      kept = stillActive;
    }
    const user = kept.metadata?.userId
      ? await userRepo.findOne({ where: { id: kept.metadata.userId } })
      : customerId
        ? await userRepo.findOne({ where: { stripeCustomerId: customerId } })
        : null;
    if (!user) return;

    const priceId = kept.items.data[0]?.price?.id;
    const plan = (kept.metadata?.planId
      ? await planRepo.findOne({ where: { id: kept.metadata.planId } })
      : null)
      ?? (priceId ? await planRepo.findOne({ where: { stripePriceId: priceId } }) : null)
      ?? launchPlan;
    if (!plan) return;

    await upsertLocalSubscription({ user, plan, stripeSubscription: kept });
  }

  const collected: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  while (collected.length < 500) {
    const page = await client.subscriptions.list({
      limit: 100,
      status: 'active',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      expand: ['data.default_payment_method', 'data.latest_invoice'],
    });
    collected.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  }
  const seen = new Set(collected.map((item) => item.id));
  await mapPool(collected, 6, async (stripeSubscription) => {
    try {
      await upsert(stripeSubscription);
    } catch (error) {
      console.error(`Falha ao sincronizar assinatura Stripe ${stripeSubscription.id}:`, error);
    }
  });

  const sessions = await client.checkout.sessions.list({ limit, status: 'complete' });
  const missing = sessions.data.filter((session) => {
    const id = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    return Boolean(id) && !seen.has(id as string);
  });
  await mapPool(missing, 4, async (session) => {
    try {
      const stripeSubscription = await client.subscriptions.retrieve(String(session.subscription), {
        expand: ['default_payment_method', 'latest_invoice'],
      });
      if (!stripeSubscription.metadata?.userId && session.metadata?.userId) {
        stripeSubscription.metadata = {
          ...stripeSubscription.metadata,
          userId: session.metadata.userId,
          planId: session.metadata.planId || stripeSubscription.metadata?.planId || '',
        };
      }
      await upsert(stripeSubscription);
    } catch (error) {
      console.error(`Falha ao sincronizar checkout Stripe ${session.id}:`, error);
    }
  });
}

export async function syncRecentStripeSubscriptionsInBackground(force = false) {
  const now = Date.now();
  if (stripeSyncRunning) return;
  if (!force && stripeSyncAt && now - stripeSyncAt < 60_000) return;
  stripeSyncRunning = true;
  try {
    try {
      await reconcilePaidPixSessions();
    } catch (error) {
      console.error('Falha ao reconciliar PIX pagos:', error);
    }
    await syncRecentStripeSubscriptions();
    stripeSyncAt = Date.now();
  } catch (error) {
    console.error('Falha ao sincronizar assinaturas Stripe em segundo plano:', error);
  } finally {
    stripeSyncRunning = false;
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
  if (paid) await applyPaidPeriodAccess(subscription, stripeInvoice);

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

export const PAYMENT_METHOD_UPDATE_PURPOSE = 'payment_method_update';

async function pixPaidAt(session: Stripe.Checkout.Session) {
  const stripeClient = requireStripe();
  const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!intentId) return new Date();
  const intent = await stripeClient.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  const created = typeof charge === 'object' && charge ? charge.created : intent.created;
  return created ? new Date(created * 1000) : new Date();
}

export async function applyOneTimePixPayment(session: Stripe.Checkout.Session) {
  if (session.mode !== 'payment' || session.metadata?.purpose !== PIX_MONTH_PURPOSE) return null;
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    throw new Error('Pagamento PIX ainda não confirmado.');
  }

  const userId = session.metadata.userId;
  const planId = session.metadata.planId;
  if (!userId || !planId) throw new Error('Sessão PIX sem assinatura.');

  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  const plan = await AppDataSource.getRepository(Plan).findOneBy({ id: planId });
  if (!user || !plan || plan.monthlyPriceCents == null) throw new Error('Plano do PIX não encontrado.');

  const gatewayId = (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id) || session.id;
  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const already = await invoiceRepo.findOne({ where: { gatewayInvoiceId: gatewayId } });
  if (already?.subscription) return already.subscription;

  const paidAt = await pixPaidAt(session);
  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  const replacementId = session.metadata.replacesBoletoSubscriptionId;
  let boletoPaidUntil: Date | null = null;
  if (replacementId) {
    const previous = await subscriptionRepo.findOne({ where: { id: replacementId, user: { id: user.id } } });
    if (!previous?.gatewaySubscriptionId) throw new Error('Assinatura de boleto não encontrada.');
    const client = requireStripe();
    const current = await client.subscriptions.retrieve(previous.gatewaySubscriptionId);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const previousCustomer = typeof current.customer === 'string' ? current.customer : current.customer.id;
    if (customerId !== previousCustomer) throw new Error('Pagamento não pertence ao cliente da assinatura.');
    const invoices = await invoiceRepo.find({ where: { subscription: { id: previous.id }, status: InvoiceStatus.PAID } });
    boletoPaidUntil = invoices.filter((invoice) => invoice.paidAt)
      .map((invoice) => addCalendarMonth(invoice.paidAt!))
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    if (current.status !== 'canceled' && current.status !== 'incomplete_expired') {
      await client.subscriptions.cancel(current.id, { invoice_now: false, prorate: false });
    }
    previous.status = SubscriptionStatus.CANCELLED;
    previous.cancelledAt = previous.cancelledAt ?? paidAt;
    await subscriptionRepo.save(previous);
  }
  let subscription = await subscriptionRepo.findOne({
    where: { user: { id: user.id } },
    order: { createdAt: 'DESC' },
  });
  if (subscription?.gatewaySubscriptionId && subscription.status === SubscriptionStatus.ACTIVE) {
    throw new Error('O usuário já possui uma assinatura ativa.');
  }
  if (!subscription || subscription.gatewaySubscriptionId) {
    subscription = subscriptionRepo.create({
      user,
      plan,
      gatewayCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? user.stripeCustomerId ?? null,
      gatewaySubscriptionId: null,
      ...(boletoPaidUntil && boletoPaidUntil > paidAt ? {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: paidAt,
        currentPeriodEnd: boletoPaidUntil,
      } : {}),
    });
  }

  const window = pixMonthWindow(paidAt, subscription);
  subscription.user = user;
  subscription.plan = plan;
  subscription.status = SubscriptionStatus.ACTIVE;
  subscription.startedAt = subscription.startedAt ?? paidAt;
  subscription.currentPeriodStart = window.periodStart;
  subscription.currentPeriodEnd = window.periodEnd;
  subscription.cancelledAt = null;
  subscription.gatewayCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? subscription.gatewayCustomerId ?? user.stripeCustomerId ?? null;
  subscription.gatewaySubscriptionId = null;
  await subscriptionRepo.save(subscription);

  await invoiceRepo.save(invoiceRepo.create({
    subscription,
    amountCents: session.amount_total && session.amount_total > 0 ? session.amount_total : PIX_MONTH_PRICE_CENTS,
    status: InvoiceStatus.PAID,
    dueDate: window.periodEnd,
    paidAt,
    gatewayInvoiceId: gatewayId,
  }));

  const pmRepo = AppDataSource.getRepository(PaymentMethod);
  const providerPaymentMethodId = `pix:${user.id}`;
  const existingMethod = await pmRepo.findOne({ where: { providerPaymentMethodId } });
  if (!existingMethod) {
    await pmRepo.save(pmRepo.create({
      user,
      type: PaymentMethodType.PIX_RECURRING,
      provider: 'stripe',
      providerPaymentMethodId,
      cardBrand: null,
      cardLastFour: null,
      active: true,
    }));
  } else {
    existingMethod.type = PaymentMethodType.PIX_RECURRING;
    existingMethod.active = true;
    await pmRepo.save(existingMethod);
  }
  const methods = await pmRepo.find({ where: { user: { id: user.id }, active: true } });
  const stale = methods.filter((method) => method.providerPaymentMethodId !== providerPaymentMethodId);
  if (stale.length) {
    for (const method of stale) method.active = false;
    await pmRepo.save(stale);
  }

  await auditSubscription(user.id, subscription.id, 'PIX_MONTH_PAID');
  return subscription;
}

export async function fulfillPaidPixCheckout(sessionId: string) {
  const session = await requireStripe().checkout.sessions.retrieve(sessionId);
  if (!pixCheckoutIsPaid(session)) return null;
  return applyOneTimePixPayment(session);
}

export async function reconcilePaidPixSessions() {
  const client = stripe;
  if (!client) return 0;
  const since = Math.floor(Date.now() / 1000) - 45 * 24 * 60 * 60;
  let startingAfter: string | undefined;
  let applied = 0;

  for (let page = 0; page < 8; page += 1) {
    const list = await client.checkout.sessions.list({
      limit: 100,
      status: 'complete',
      created: { gte: since },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of list.data) {
      if (!pixCheckoutIsPaid(session)) continue;
      try {
        await applyOneTimePixPayment(session);
        applied += 1;
      } catch (error) {
        console.error(`Falha ao confirmar PIX ${session.id}:`, error);
      }
    }
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1]?.id;
  }

  return applied;
}

export async function reconcileUserPixPayments(userId: string) {
  const client = stripe;
  if (!client) return;
  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  if (!user?.stripeCustomerId) return;
  const sessions = await client.checkout.sessions.list({
    customer: user.stripeCustomerId,
    limit: 20,
    status: 'complete',
  });
  for (const session of sessions.data) {
    if (!pixCheckoutIsPaid(session)) continue;
    await applyOneTimePixPayment(session);
  }
}

export type PaymentMethodUpdateResult = {
  message: string;
  invoicePaid: boolean;
  chargeFailed: boolean;
};

function stripeErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function invoiceAlreadyPaid(error: unknown) {
  const code = (error as { code?: string }).code;
  return code === 'invoice_already_paid' || /already paid/i.test(stripeErrorText(error));
}

async function keepOnlyActivePaymentMethod(userId: string, providerPaymentMethodId: string) {
  const pmRepo = AppDataSource.getRepository(PaymentMethod);
  const methods = await pmRepo.find({ where: { user: { id: userId }, active: true } });
  const stale = methods.filter((method) => method.providerPaymentMethodId !== providerPaymentMethodId);
  if (stale.length === 0) return;
  for (const method of stale) method.active = false;
  await pmRepo.save(stale);
}

export async function applySetupPaymentMethod(session: Stripe.Checkout.Session): Promise<PaymentMethodUpdateResult | null> {
  if (session.metadata?.purpose !== PAYMENT_METHOD_UPDATE_PURPOSE || session.mode !== 'setup') return null;
  if (session.status !== 'complete') {
    throw new Error('Troca de cartão ainda não confirmada.');
  }

  const userId = session.metadata.userId;
  const subscriptionId = session.metadata.subscriptionId;
  if (!userId || !subscriptionId) throw new Error('Sessão sem assinatura.');

  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  const subscription = await AppDataSource.getRepository(Subscription).findOne({
    where: { id: subscriptionId, user: { id: userId } },
  });
  if (!user || !subscription?.gatewaySubscriptionId) {
    throw new Error('Assinatura não encontrada para esta troca de cartão.');
  }

  const stripeClient = requireStripe();
  const setupIntentId = typeof session.setup_intent === 'string'
    ? session.setup_intent
    : session.setup_intent?.id;
  if (!setupIntentId) throw new Error('A Stripe não devolveu o cartão desta sessão.');

  const setupIntent = await stripeClient.setupIntents.retrieve(setupIntentId, {
    expand: ['payment_method'],
  });
  const rawPaymentMethod = setupIntent.payment_method;
  const paymentMethodId = typeof rawPaymentMethod === 'string' ? rawPaymentMethod : rawPaymentMethod?.id;
  if (!paymentMethodId) throw new Error('A Stripe não devolveu o cartão desta sessão.');

  const paymentMethod = typeof rawPaymentMethod === 'object' && rawPaymentMethod
    ? rawPaymentMethod
    : await stripeClient.paymentMethods.retrieve(paymentMethodId);
  if (paymentMethod.type !== 'card') {
    throw new Error('A sessão não confirmou um cartão.');
  }

  const customerId = subscription.gatewayCustomerId
    || user.stripeCustomerId
    || (typeof session.customer === 'string' ? session.customer : session.customer?.id);
  if (!customerId) throw new Error('A assinatura atual não está vinculada à Stripe.');

  await stripeClient.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  const current = await stripeClient.subscriptions.retrieve(subscription.gatewaySubscriptionId);
  let updated = await stripeClient.subscriptions.update(subscription.gatewaySubscriptionId, {
    default_payment_method: paymentMethodId,
    collection_method: 'charge_automatically',
    payment_settings: { payment_method_types: ['card'] },
    metadata: { ...current.metadata, paymentMethodType: 'CREDIT_CARD' },
    expand: ['default_payment_method', 'latest_invoice'],
  });

  let invoicePaid = false;
  let chargeFailed = false;
  const latestInvoice = typeof updated.latest_invoice === 'string'
    ? await stripeClient.invoices.retrieve(updated.latest_invoice)
    : updated.latest_invoice;
  if (latestInvoice?.id && latestInvoice.status === 'open' && latestInvoice.amount_due > 0) {
    try {
      await stripeClient.invoices.update(latestInvoice.id, {
        default_payment_method: paymentMethodId,
        payment_settings: { payment_method_types: ['card'] },
      });
      await stripeClient.invoices.pay(latestInvoice.id, { payment_method: paymentMethodId });
      invoicePaid = true;
      updated = await stripeClient.subscriptions.retrieve(subscription.gatewaySubscriptionId, {
        expand: ['default_payment_method', 'latest_invoice'],
      });
    } catch (error) {
      if (invoiceAlreadyPaid(error)) {
        invoicePaid = true;
        updated = await stripeClient.subscriptions.retrieve(subscription.gatewaySubscriptionId, {
          expand: ['default_payment_method', 'latest_invoice'],
        });
      } else {
        chargeFailed = true;
        console.warn('Cartão salvo, mas a fatura em aberto não foi paga:', stripeErrorText(error));
      }
    }
  }

  const saved = await upsertLocalSubscription({
    user,
    plan: subscription.plan,
    stripeSubscription: updated,
    paymentMethod: {
      stripeId: paymentMethodId,
      brand: paymentMethod.card?.brand ?? null,
      last4: paymentMethod.card?.last4 ?? null,
      type: PaymentMethodType.CREDIT_CARD,
    },
  });
  await keepOnlyActivePaymentMethod(user.id, paymentMethodId);
  try {
    await syncStripeInvoices(saved);
  } catch (error) {
    console.error('Falha ao sincronizar faturas após troca de cartão:', error);
  }
  await auditSubscription(user.id, saved.id, 'PAYMENT_METHOD_UPDATED');

  return {
    invoicePaid,
    chargeFailed,
    message: chargeFailed
      ? 'Cartão atualizado, mas a cobrança da mensalidade não passou. Tente outro cartão.'
      : invoicePaid
        ? 'Cartão atualizado e a mensalidade em aberto foi paga.'
        : 'Cartão atualizado. As próximas cobranças usarão este cartão.',
  };
}
