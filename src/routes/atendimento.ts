import { Router } from 'express';
import { In } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { LAUNCH_CASHBACK_CUTOFF } from '../config/business-rules';
import { User, UserRole } from '../entities/User';
import { SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { PaymentMethod, PaymentMethodType } from '../entities/PaymentMethod';
import { boletoCustomerIds } from '../services/boleto-customers';
import { audit } from '../services/audit';
import { cacheDel, cacheGet, cacheSet } from '../services/cache';
import { membershipAccess } from '../services/membership-access';
import { repairPaidThroughSubscriptions, syncRecentStripeSubscriptions, syncRecentStripeSubscriptionsInBackground } from '../services/stripe-billing';

const MEMBERS_CACHE_KEY = 'atendimento:members:v5';
const MEMBERS_CACHE_TTL = 45;

export const atendimentoRouter = Router();

const JOINED_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAYMENT_FAILED,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.SUSPENDED,
  SubscriptionStatus.CANCELLED,
]);

function hasJoined(user: User) {
  return (user.subscriptions ?? []).length > 0;
}

function hasSigned(user: User) {
  return (user.subscriptions ?? []).some(
    (subscription) => JOINED_STATUSES.has(subscription.status) || Boolean(subscription.startedAt),
  );
}

function launchSubscription(user: User) {
  return (user.subscriptions ?? [])
    .filter((subscription) => subscription.plan?.code === 'LAUNCH')
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
}

function latestSubscription(user: User) {
  return [...(user.subscriptions ?? [])].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  )[0];
}

async function findByIds<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>) {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    rows.push(...await load(ids.slice(index, index + 400)));
  }
  return rows;
}

function latestPaymentMethod(user: User) {
  return [...(user.paymentMethods ?? [])].sort(
    (a, b) => Number(b.active) - Number(a.active) || +new Date(b.createdAt) - +new Date(a.createdAt),
  )[0];
}

function isBoletoCustomer(user: User, boletoIds: Set<string>) {
  if ((user.paymentMethods ?? []).some((method) => method.type === PaymentMethodType.BOLETO)) return true;
  const customerId = user.stripeCustomerId || latestSubscription(user)?.gatewayCustomerId;
  return Boolean(customerId && boletoIds.has(customerId));
}

function serializeMember(user: User, boletoIds: Set<string>) {
  const latest = latestSubscription(user);
  const access = membershipAccess(latest, latest?.invoices ?? []);
  const paymentMethod = latestPaymentMethod(user);
  const launch = launchSubscription(user);
  const launchJoined = Boolean(launch && (JOINED_STATUSES.has(launch.status) || launch.startedAt));
  const grandfathered = Boolean(
    user.launchCashbackEligibleAt
      || (launchJoined && launch && launch.createdAt < LAUNCH_CASHBACK_CUTOFF),
  );
  const used = Boolean(user.launchCashbackUsedAt);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    companyName: user.companyName ?? null,
    document: user.document ?? null,
    city: user.city ?? null,
    state: user.state ?? null,
    phone: user.phone ?? null,
    createdAt: user.createdAt,
    boleto: isBoletoCustomer(user, boletoIds),
    subscription: latest
      ? {
          id: latest.id,
          status: latest.status,
          startedAt: latest.startedAt,
          currentPeriodEnd: latest.currentPeriodEnd,
          validUntil: access.validUntil,
          active: access.active,
          renewed: access.renewed,
          renewedAt: access.renewedAt,
          plan: latest.plan
            ? {
                id: latest.plan.id,
                code: latest.plan.code,
                name: latest.plan.name,
                monthlyPriceCents: latest.plan.monthlyPriceCents,
              }
            : null,
        }
      : null,
    paymentMethod: paymentMethod
      ? {
          type: paymentMethod.type,
          cardBrand: paymentMethod.cardBrand ?? null,
          cardLastFour: paymentMethod.cardLastFour ?? null,
        }
      : null,
    cashback: {
      eligible: grandfathered,
      amountCents: grandfathered ? 14997 : 0,
      used,
      usedAt: user.launchCashbackUsedAt,
    },
  };
}

async function listMembers() {
  const users = await AppDataSource.getRepository(User)
    .createQueryBuilder('user')
    .leftJoinAndSelect('user.subscriptions', 'subscription')
    .leftJoinAndSelect('subscription.plan', 'plan')
    .where('user.role = :role', { role: UserRole.CUSTOMER })
    .orderBy('user.createdAt', 'DESC')
    .take(1000)
    .getMany();

  for (const user of users) {
    user.paymentMethods = [];
    for (const subscription of user.subscriptions ?? []) subscription.invoices = [];
  }

  const subscriptionIds = users.flatMap((user) => (user.subscriptions ?? []).map((subscription) => subscription.id));
  const userIds = users.map((user) => user.id);
  if (subscriptionIds.length) {
    const invoices = await findByIds(subscriptionIds, (ids) => AppDataSource.getRepository(Invoice).find({
      where: { status: InvoiceStatus.PAID, subscription: { id: In(ids) } },
    }));
    const bySubscription = new Map(
      users.flatMap((user) => (user.subscriptions ?? []).map((subscription) => [subscription.id, subscription] as const)),
    );
    for (const invoice of invoices) {
      const subscription = invoice.subscription?.id ? bySubscription.get(invoice.subscription.id) : undefined;
      if (subscription) subscription.invoices.push(invoice);
    }
  }
  if (userIds.length) {
    const methods = await findByIds(userIds, (ids) => AppDataSource.getRepository(PaymentMethod).find({
      where: { user: { id: In(ids) } },
    }));
    const byUser = new Map(users.map((user) => [user.id, user] as const));
    for (const method of methods) {
      const owner = method.user?.id ? byUser.get(method.user.id) : undefined;
      if (owner) owner.paymentMethods.push(method);
    }
  }

  let boletoIds = new Set<string>();
  try {
    boletoIds = await boletoCustomerIds();
  } catch (error) {
    console.error('Falha ao identificar pagamentos por boleto:', error);
  }

  const joined = [];
  const unsigned = [];
  for (const user of users) {
    const member = serializeMember(user, boletoIds);
    if (hasSigned(user)) joined.push(member);
    else unsigned.push(member);
  }

  joined.sort((a, b) => {
    const aActive = a.subscription?.active ? 1 : 0;
    const bActive = b.subscription?.active ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aTime = a.subscription?.validUntil || a.subscription?.startedAt || a.createdAt;
    const bTime = b.subscription?.validUntil || b.subscription?.startedAt || b.createdAt;
    return +new Date(bTime) - +new Date(aTime);
  });

  return { joined, unsigned };
}

atendimentoRouter.get('/members', async (req, res) => {
  const refresh = String(req.query.refresh || '') === '1';
  const repaired = await repairPaidThroughSubscriptions();
  if (repaired) await cacheDel(MEMBERS_CACHE_KEY);
  if (!refresh) {
    const cached = await cacheGet<{ joined: unknown[]; unsigned: unknown[] }>(MEMBERS_CACHE_KEY);
    if (cached) {
      res.json(cached);
      void syncRecentStripeSubscriptionsInBackground().then(() => cacheDel(MEMBERS_CACHE_KEY));
      return;
    }
  } else {
    try {
      await Promise.race([
        syncRecentStripeSubscriptions(),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('stripe-sync-timeout')), 4000); }),
      ]);
    } catch (error) {
      console.error('Sincronização Stripe no atualizar:', error);
    }
    await cacheDel(MEMBERS_CACHE_KEY);
  }

  const payload = await listMembers();
  res.json(payload);
  await cacheSet(MEMBERS_CACHE_KEY, payload, MEMBERS_CACHE_TTL);
  if (!refresh) {
    void syncRecentStripeSubscriptionsInBackground().then(() => cacheDel(MEMBERS_CACHE_KEY));
  }
});

atendimentoRouter.post('/members/:id/cashback-use', async (req, res) => {
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({
    where: { id: req.params.id, role: UserRole.CUSTOMER },
    relations: ['subscriptions', 'subscriptions.plan', 'subscriptions.invoices', 'paymentMethods'],
  });
  if (!user || !hasJoined(user)) {
    return res.status(404).json({ message: 'Cliente do clube n\u00e3o encontrado.' });
  }

  let boletoIds = new Set<string>();
  try {
    boletoIds = await boletoCustomerIds();
  } catch (error) {
    console.error('Falha ao identificar pagamentos por boleto:', error);
  }
  const member = serializeMember(user, boletoIds);
  if (!member.cashback.eligible) {
    return res.status(400).json({ message: 'Este cliente n\u00e3o tem cashback de lan\u00e7amento.' });
  }
  if (user.launchCashbackUsedAt) {
    return res.status(409).json({ message: 'Cashback j\u00e1 utilizado.', member: serializeMember(user, boletoIds) });
  }

  user.launchCashbackUsedAt = new Date();
  user.launchCashbackUsedById = req.auth?.sub ?? null;
  await userRepo.save(user);
  await cacheDel(MEMBERS_CACHE_KEY);
  await audit({
    actorUserId: req.auth?.sub ?? null,
    action: 'LAUNCH_CASHBACK_USED',
    entity: 'user',
    entityId: user.id,
    metadata: { amountCents: member.cashback.amountCents },
  });

  res.json(serializeMember(user, boletoIds));
});
