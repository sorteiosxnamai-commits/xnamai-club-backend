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

adminRouter.get('/dashboard', async (_req, res) => {
  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  const invoiceRepo = AppDataSource.getRepository(Invoice);

  let activeSubscribers = await subscriptionRepo.count({ where: { status: SubscriptionStatus.ACTIVE } });
  const billableStatuses = [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE];
  const billable = await subscriptionRepo.count({ where: { status: In(billableStatuses) } });
  const pastDue = await subscriptionRepo.count({ where: { status: In([SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE]) } });
  const complianceRate = billable === 0 ? 100 : ((billable - pastDue) / billable) * 100;

  const months = lastMonths(6);
  const current = months[months.length - 1];
  const previous = months[months.length - 2];
  const now = new Date();
  let stripeMrr: Awaited<ReturnType<typeof loadStripeMrrTimeline>> = null;
  try {
    stripeMrr = await loadStripeMrrTimeline(months.map((month, index) => ({
      at: index === months.length - 1 ? now : new Date(month.end.getTime() - 1),
    })));
  } catch (error) {
    console.error('Falha ao calcular a MRR da Stripe:', error);
  }

  let monthlyRevenueCents = 0;
  let previousRevenueCents = 0;
  let revenueByMonth = months.map((month) => ({ key: month.key, label: month.label, revenueCents: 0 }));
  if (stripeMrr) {
    activeSubscribers = stripeMrr.subscribers;
    monthlyRevenueCents = stripeMrr.currentCents;
    previousRevenueCents = stripeMrr.points[stripeMrr.points.length - 2] ?? 0;
    revenueByMonth = months.map((month, index) => ({
      key: month.key,
      label: month.label,
      revenueCents: stripeMrr!.points[index] ?? 0,
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
  });
  const newSubscribers = await subscriptionRepo.count({
    where: { createdAt: Between(current.start, current.end) },
  });

  const forecast = stripeMrr
    ? {
        forecastSubscribers: stripeMrr.subscribers,
        unpricedSubscribers: 0,
        nextMonthForecastCents: stripeMrr.currentCents,
        yearForecastCents: stripeMrr.currentCents * 12,
        forecastByMonth: Array.from({ length: 12 }, (_, index) => {
          const month = monthRange(index + 1);
          return { key: month.key, label: `${month.label}/${String(month.year).slice(2)}`, revenueCents: stripeMrr.currentCents };
        }),
      }
    : await buildRevenueForecast();

  res.json({
    activeSubscribers,
    complianceRate: Number(complianceRate.toFixed(1)),
    rejectedPayments,
    monthlyRevenueCents,
    previousRevenueCents,
    growthPercent,
    newSubscribers,
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
  res.json(rows.map((subscription) => ({
    id: subscription.id,
    status: subscription.status,
    startedAt: subscription.startedAt,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelledAt: subscription.cancelledAt,
    createdAt: subscription.createdAt,
    gatewaySubscriptionId: subscription.gatewaySubscriptionId,
    plan: planSummary(subscription.plan),
    customer: customerSummary(subscription.user),
  })));
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
  try {
    await syncAllStripeInvoices();
  } catch (error) {
    console.error('Falha ao sincronizar faturas Stripe nas cobranças admin:', error);
  }

  const rows = await AppDataSource.getRepository(Invoice).find({
    order: { createdAt: 'DESC' },
    take: 100,
    relations: ['subscription', 'subscription.user', 'subscription.plan'],
  });
  let stripeMrr: Awaited<ReturnType<typeof loadStripeMrrTimeline>> = null;
  try {
    stripeMrr = await loadStripeMrrTimeline([{ at: new Date() }]);
  } catch (error) {
    console.error('Falha ao calcular a MRR da Stripe nas cobranças:', error);
  }
  const forecast = await buildRevenueForecast();
  if (stripeMrr) {
    forecast.forecastSubscribers = stripeMrr.subscribers;
    forecast.unpricedSubscribers = 0;
    forecast.nextMonthForecastCents = stripeMrr.currentCents;
    forecast.yearForecastCents = stripeMrr.currentCents * 12;
    forecast.forecastByMonth = forecast.forecastByMonth.map((month) => ({ ...month, revenueCents: stripeMrr.currentCents }));
  }
  res.json({
    nextMonthForecastCents: forecast.nextMonthForecastCents,
    yearForecastCents: forecast.yearForecastCents,
    forecastSubscribers: forecast.forecastSubscribers,
    forecastByMonth: forecast.forecastByMonth,
    upcoming: forecast.upcomingCharges,
    unpricedSubscribers: forecast.unpricedSubscribers,
    invoices: rows.map((invoice) => ({
      id: invoice.id,
      amountCents: invoice.amountCents,
      status: invoice.status,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      createdAt: invoice.createdAt,
      gatewayInvoiceId: invoice.gatewayInvoiceId,
      plan: planSummary(invoice.subscription?.plan),
      customer: customerSummary(invoice.subscription?.user),
    })),
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
