import { Router } from 'express';
import { Between, In } from 'typeorm';
import { z } from 'zod';
import { AppDataSource } from '../config/data-source';
import { requireAuth, requireRole } from '../middleware/auth';
import { User, UserRole } from '../entities/User';
import { Plan } from '../entities/Plan';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { pickPrimarySubscription } from '../services/membership-access';
import { syncAllStripeInvoices } from '../services/stripe-billing';
import { buildRevenueForecast } from '../services/revenue-forecast';
import { loadStripeMrrTimeline } from '../services/stripe-mrr';
import {
  asaasCreatedCount,
  asaasMrrTimeline,
  asaasPaymentRows,
  asaasRejectedCount,
  asaasSubscriptionRows,
  asaasUpcomingCharges,
  combineMrr,
  loadAsaasSnapshot,
  type GatewayMrr,
} from '../services/asaas-billing';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole(UserRole.ADMIN));

const MONTHS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function saoPauloYearMonth(date = new Date(), monthOffset = 0) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: 'numeric' })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  let year = Number(parts.year);
  let monthIndex = Number(parts.month) - 1 + monthOffset;
  year += Math.floor(monthIndex / 12);
  monthIndex = ((monthIndex % 12) + 12) % 12;
  return { year, monthIndex };
}

function monthRange(offset = 0) {
  const current = saoPauloYearMonth(new Date(), offset);
  const next = saoPauloYearMonth(new Date(), offset + 1);
  return {
    start: new Date(Date.UTC(current.year, current.monthIndex, 1, 3, 0, 0, 0)),
    end: new Date(Date.UTC(next.year, next.monthIndex, 1, 3, 0, 0, 0)),
    year: current.year,
    monthIndex: current.monthIndex,
    label: MONTHS_PT[current.monthIndex],
    key: `${current.year}-${String(current.monthIndex + 1).padStart(2, '0')}`,
  };
}

function lastMonths(count = 6) {
  return Array.from({ length: count }, (_, index) => monthRange(index - (count - 1)));
}

function sumPaidInRange(invoices: Invoice[], start: Date, end: Date) {
  return invoices.reduce((sum, invoice) => {
    const paidAt = invoice.paidAt ?? invoice.createdAt;
    if (paidAt >= start && paidAt < end) return sum + invoice.amountCents;
    return sum;
  }, 0);
}

function growthPercentBetween(currentCents: number, previousCents: number) {
  if (previousCents === 0) return currentCents > 0 ? 100 : 0;
  return Number((((currentCents - previousCents) / previousCents) * 100).toFixed(1));
}

function flatForecast(cents: number, subscribers: number) {
  return {
    forecastSubscribers: subscribers,
    unpricedSubscribers: 0,
    nextMonthForecastCents: cents,
    yearForecastCents: cents * 12,
    forecastByMonth: Array.from({ length: 12 }, (_, index) => {
      const month = monthRange(index + 1);
      return { key: month.key, label: `${month.label}/${String(month.year).slice(2)}`, revenueCents: cents };
    }),
  };
}

function gatewaySources(stripe: GatewayMrr | null, asaas: GatewayMrr | null) {
  return [
    ...(stripe ? ['stripe'] : []),
    ...(asaas ? ['asaas'] : []),
  ];
}

function paymentSortKey(row: { paidAt?: string | Date | null; dueDate?: string | Date | null; createdAt?: string | Date | null }) {
  const value = row.paidAt || row.dueDate || row.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

adminRouter.get('/dashboard', async (_req, res) => {
  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  const invoiceRepo = AppDataSource.getRepository(Invoice);

  let activeSubscribers = await subscriptionRepo.count({ where: { status: SubscriptionStatus.ACTIVE } });
  const billableStatuses = [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE];
  const billable = await subscriptionRepo.count({ where: { status: In(billableStatuses) } });
  const pastDue = await subscriptionRepo.count({ where: { status: In([SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE]) } });
  let complianceRate = billable === 0 ? 100 : ((billable - pastDue) / billable) * 100;

  const months = lastMonths(6);
  const current = months[months.length - 1];
  const previous = months[months.length - 2];
  const now = new Date();
  const points = months.map((month, index) => ({
    at: index === months.length - 1 ? now : new Date(month.end.getTime() - 1),
  }));
  const [stripeMrr, asaasSnapshot] = await Promise.all([
    loadStripeMrrTimeline(points).catch((error: unknown) => {
      console.error('Falha ao calcular a MRR da Stripe:', error);
      return null;
    }),
    loadAsaasSnapshot(),
  ]);
  const asaasMrr = asaasSnapshot ? asaasMrrTimeline(asaasSnapshot, points, now) : null;
  const combinedMrr = combineMrr([stripeMrr, asaasMrr]);

  let monthlyRevenueCents = 0;
  let previousRevenueCents = 0;
  let revenueByMonth = months.map((month) => ({ key: month.key, label: month.label, revenueCents: 0 }));
  if (combinedMrr) {
    activeSubscribers = combinedMrr.subscribers;
    const billable = combinedMrr.subscribers;
    complianceRate = billable === 0 ? 100 : ((billable - combinedMrr.pastDue) / billable) * 100;
    monthlyRevenueCents = combinedMrr.currentCents;
    previousRevenueCents = combinedMrr.points[combinedMrr.points.length - 2] ?? 0;
    revenueByMonth = months.map((month, index) => ({
      key: month.key,
      label: month.label,
      revenueCents: combinedMrr.points[index] ?? 0,
    }));
  } else {
    try {
      await syncAllStripeInvoices();
    } catch (error) {
      console.error('Falha ao sincronizar faturas Stripe no dashboard admin:', error);
    }
    const paidInvoices = await invoiceRepo
      .createQueryBuilder('invoice')
      .where('invoice.status = :status', { status: InvoiceStatus.PAID })
      .andWhere('COALESCE(invoice.paidAt, invoice.createdAt) >= :start', { start: months[0].start })
      .andWhere('COALESCE(invoice.paidAt, invoice.createdAt) < :end', { end: current.end })
      .getMany();
    monthlyRevenueCents = sumPaidInRange(paidInvoices, current.start, current.end);
    previousRevenueCents = sumPaidInRange(paidInvoices, previous.start, previous.end);
    revenueByMonth = months.map((month) => ({
      key: month.key,
      label: month.label,
      revenueCents: sumPaidInRange(paidInvoices, month.start, month.end),
    }));
  }
  const growthPercent = growthPercentBetween(monthlyRevenueCents, previousRevenueCents);

  const rejectedPayments = await invoiceRepo.count({
    where: { status: InvoiceStatus.FAILED, createdAt: Between(current.start, current.end) },
  }) + (asaasSnapshot ? asaasRejectedCount(asaasSnapshot.payments, current.start, current.end) : 0);
  const newSubscribers = await subscriptionRepo.count({
    where: { createdAt: Between(current.start, current.end) },
  }) + (asaasSnapshot ? asaasCreatedCount(asaasSnapshot.subscriptions, current.start, current.end) : 0);

  const forecast = combinedMrr
    ? flatForecast(combinedMrr.currentCents, combinedMrr.subscribers)
    : await buildRevenueForecast();

  res.json({
    activeSubscribers,
    complianceRate: Number(complianceRate.toFixed(1)),
    rejectedPayments,
    monthlyRevenueCents,
    previousRevenueCents,
    growthPercent,
    newSubscribers,
    sources: gatewaySources(stripeMrr, asaasMrr),
    revenueByMonth,
    nextMonthForecastCents: forecast.nextMonthForecastCents,
    yearForecastCents: forecast.yearForecastCents,
    forecastSubscribers: forecast.forecastSubscribers,
    unpricedSubscribers: forecast.unpricedSubscribers,
    forecastByMonth: forecast.forecastByMonth,
  });
});

function customerSummary(user?: User | null) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    companyName: user.companyName ?? null,
    document: user.document ?? null,
    city: user.city ?? null,
    state: user.state ?? null,
    phone: user.phone ?? null,
  };
}

function planSummary(plan?: Plan | null) {
  if (!plan) return null;
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    monthlyPriceCents: plan.monthlyPriceCents,
  };
}

adminRouter.get('/subscriptions', async (_req, res) => {
  const rows = await AppDataSource.getRepository(Subscription).find({
    order: { createdAt: 'DESC' },
    relations: ['user', 'plan'],
  });
  const asaasSnapshot = await loadAsaasSnapshot();
  const local = rows.map((subscription) => ({
    id: subscription.id,
    status: subscription.status,
    startedAt: subscription.startedAt,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelledAt: subscription.cancelledAt,
    createdAt: subscription.createdAt,
    gatewaySubscriptionId: subscription.gatewaySubscriptionId,
    provider: 'stripe' as const,
    frequency: subscription.gatewaySubscriptionId ? 'Mensal' : 'Avulsa',
    plan: planSummary(subscription.plan),
    customer: customerSummary(subscription.user),
  }));
  const remote = asaasSnapshot ? asaasSubscriptionRows(asaasSnapshot) : [];
  res.json([...local, ...remote].sort((a, b) => paymentSortKey({ createdAt: b.createdAt }) - paymentSortKey({ createdAt: a.createdAt })));
});

adminRouter.get('/customers', async (_req, res) => {
  const users = await AppDataSource.getRepository(User).find({
    where: { role: UserRole.CUSTOMER },
    order: { createdAt: 'DESC' },
    take: 100,
    relations: ['subscriptions', 'subscriptions.plan'],
  });
  res.json(users.map((user) => {
    const latest = pickPrimarySubscription(user.subscriptions ?? []);
    return {
      ...customerSummary(user),
      createdAt: user.createdAt,
      subscription: latest
        ? {
            id: latest.id,
            status: latest.status,
            currentPeriodEnd: latest.currentPeriodEnd,
            plan: planSummary(latest.plan),
          }
        : null,
    };
  }));
});

adminRouter.get('/payments', async (_req, res) => {
  const now = new Date();
  const [asaasSnapshot] = await Promise.all([
    loadAsaasSnapshot(),
    syncAllStripeInvoices().catch((error: unknown) => {
      console.error('Falha ao sincronizar faturas Stripe nas cobranças admin:', error);
    }),
  ]);

  const rows = await AppDataSource.getRepository(Invoice).find({
    order: { createdAt: 'DESC' },
    take: 100,
    relations: ['subscription', 'subscription.user', 'subscription.plan'],
  });
  const [stripeMrr, forecast] = await Promise.all([
    loadStripeMrrTimeline([{ at: now }]).catch((error: unknown) => {
      console.error('Falha ao calcular a MRR da Stripe nas cobranças:', error);
      return null;
    }),
    buildRevenueForecast(),
  ]);
  const asaasMrr = asaasSnapshot ? asaasMrrTimeline(asaasSnapshot, [{ at: now }], now) : null;
  const combinedMrr = combineMrr([stripeMrr, asaasMrr]);
  if (combinedMrr) {
    forecast.forecastSubscribers = combinedMrr.subscribers;
    forecast.unpricedSubscribers = 0;
    forecast.nextMonthForecastCents = combinedMrr.currentCents;
    forecast.yearForecastCents = combinedMrr.currentCents * 12;
    forecast.forecastByMonth = forecast.forecastByMonth.map((month) => ({ ...month, revenueCents: combinedMrr.currentCents }));
  }
  const stripeInvoices = rows.map((invoice) => ({
    id: invoice.id,
    amountCents: invoice.amountCents,
    status: invoice.status,
    dueDate: invoice.dueDate,
    paidAt: invoice.paidAt,
    createdAt: invoice.createdAt,
    gatewayInvoiceId: invoice.gatewayInvoiceId,
    provider: 'stripe' as const,
    description: `Mensalidade ${invoice.subscription?.plan?.name || 'XNaMai Club'} · Stripe`,
    plan: planSummary(invoice.subscription?.plan),
    customer: customerSummary(invoice.subscription?.user),
  }));
  const invoices = [...stripeInvoices, ...(asaasSnapshot ? asaasPaymentRows(asaasSnapshot) : [])]
    .sort((a, b) => paymentSortKey(b) - paymentSortKey(a))
    .slice(0, 100);
  const upcoming = [
    ...forecast.upcomingCharges.map((charge) => ({
      ...charge,
      provider: 'stripe' as const,
      description: `Mensalidade ${charge.plan?.name || 'XNaMai Club'} · Stripe`,
    })),
    ...(asaasSnapshot ? asaasUpcomingCharges(asaasSnapshot, now) : []),
  ].sort((a, b) => paymentSortKey(a) - paymentSortKey(b));
  res.json({
    nextMonthForecastCents: forecast.nextMonthForecastCents,
    yearForecastCents: forecast.yearForecastCents,
    forecastSubscribers: forecast.forecastSubscribers,
    forecastByMonth: forecast.forecastByMonth,
    upcoming,
    unpricedSubscribers: forecast.unpricedSubscribers,
    invoices,
  });
});

adminRouter.get('/plans', async (_req, res) => {
  res.json(await AppDataSource.getRepository(Plan).find({ order: { sortOrder: 'ASC' } }));
});

const updatePlanSchema = z.object({
  stripePriceId: z.string().min(3).nullable().optional(),
  monthlyPriceCents: z.number().int().nonnegative().nullable().optional(),
  active: z.boolean().optional(),
});

adminRouter.patch('/plans/:id', async (req, res) => {
  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Dados inválidos.', issues: parsed.error.flatten() });

  const planRepo = AppDataSource.getRepository(Plan);
  const plan = await planRepo.findOne({ where: { id: req.params.id } });
  if (!plan) return res.status(404).json({ message: 'Plano não encontrado.' });

  Object.assign(plan, parsed.data);
  res.json(await planRepo.save(plan));
});
