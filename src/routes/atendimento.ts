import { Router } from 'express';
import { AppDataSource } from '../config/data-source';
import { User, UserRole } from '../entities/User';
import { SubscriptionStatus } from '../entities/Subscription';
import { audit } from '../services/audit';
import { syncRecentStripeSubscriptions } from '../services/stripe-billing';

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

function serializeMember(user: User) {
  const latest = latestSubscription(user);
  const launch = launchSubscription(user);
  const launchJoined = Boolean(launch && (JOINED_STATUSES.has(launch.status) || launch.startedAt));
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
    subscription: latest
      ? {
          id: latest.id,
          status: latest.status,
          startedAt: latest.startedAt,
          currentPeriodEnd: latest.currentPeriodEnd,
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
    cashback: {
      eligible: launchJoined,
      amountCents: launchJoined ? (launch?.plan?.monthlyPriceCents ?? 14997) : 0,
      used,
      usedAt: user.launchCashbackUsedAt,
    },
  };
}

atendimentoRouter.get('/members', async (_req, res) => {
  try {
    await syncRecentStripeSubscriptions();
  } catch (error) {
    console.error('Falha ao sincronizar assinaturas Stripe no atendimento:', error);
  }

  const users = await AppDataSource.getRepository(User).find({
    where: { role: UserRole.CUSTOMER },
    relations: ['subscriptions', 'subscriptions.plan'],
    order: { createdAt: 'DESC' },
    take: 1000,
  });

  const joined = [];
  const unsigned = [];
  for (const user of users) {
    const member = serializeMember(user);
    if (hasSigned(user)) joined.push(member);
    else unsigned.push(member);
  }

  joined.sort((a, b) => {
    const aTime = a.subscription?.startedAt || a.createdAt;
    const bTime = b.subscription?.startedAt || b.createdAt;
    return +new Date(bTime) - +new Date(aTime);
  });

  res.json({ joined, unsigned });
});

atendimentoRouter.post('/members/:id/cashback-use', async (req, res) => {
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({
    where: { id: req.params.id, role: UserRole.CUSTOMER },
    relations: ['subscriptions', 'subscriptions.plan'],
  });
  if (!user || !hasJoined(user)) {
    return res.status(404).json({ message: 'Cliente do clube n\u00e3o encontrado.' });
  }

  const member = serializeMember(user);
  if (!member.cashback.eligible) {
    return res.status(400).json({ message: 'Este cliente n\u00e3o tem cashback de lan\u00e7amento.' });
  }
  if (user.launchCashbackUsedAt) {
    return res.status(409).json({ message: 'Cashback j\u00e1 utilizado.', member: serializeMember(user) });
  }

  user.launchCashbackUsedAt = new Date();
  user.launchCashbackUsedById = req.auth?.sub ?? null;
  await userRepo.save(user);
  await audit({
    actorUserId: req.auth?.sub ?? null,
    action: 'LAUNCH_CASHBACK_USED',
    entity: 'user',
    entityId: user.id,
    metadata: { amountCents: member.cashback.amountCents },
  });

  res.json(serializeMember(user));
});
