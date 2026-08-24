import { Router } from 'express';
import { Between, In } from 'typeorm';
import { z } from 'zod';
import { AppDataSource } from '../config/data-source';
import { requireAuth, requireRole } from '../middleware/auth';
import { User, UserRole } from '../entities/User';
import { Plan } from '../entities/Plan';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { syncAllStripeInvoices } from '../services/stripe-billing';

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

adminRouter.get('/dashboard', async (_req, res) => {
  try {
    await syncAllStripeInvoices();
  } catch (error) {
    console.error('Falha ao sincronizar faturas Stripe no dashboard admin:', error);
  }

  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  const invoiceRepo = AppDataSource.getRepository(Invoice);

  const activeSubscribers = await subscriptionRepo.count({ where: { status: SubscriptionStatus.ACTIVE } });
  const billableStatuses = [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE];
  const billable = await subscriptionRepo.count({ where: { status: In(billableStatuses) } });
  const pastDue = await subscriptionRepo.count({ where: { status: In([SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE]) } });
  const complianceRate = billable === 0 ? 100 : ((billable - pastDue) / billable) * 100;

  const months = lastMonths(6);
  const current = months[months.length - 1];
  const previous = months[months.length - 2];
  const paidInvoices = await invoiceRepo
    .createQueryBuilder('invoice')
    .where('invoice.status = :status', { status: InvoiceStatus.PAID })
    .andWhere('COALESCE(invoice.paidAt, invoice.createdAt) >= :start', { start: months[0].start })
    .andWhere('COALESCE(invoice.paidAt, invoice.createdAt) < :end', { end: current.end })
    .getMany();
  const monthlyRevenueCents = sumPaidInRange(paidInvoices, current.start, current.end);
  const previousRevenueCents = sumPaidInRange(paidInvoices, previous.start, previous.end);
  const growthPercent = previousRevenueCents === 0
    ? (monthlyRevenueCents > 0 ? 100 : 0)
    : Number((((monthlyRevenueCents - previousRevenueCents) / previousRevenueCents) * 100).toFixed(1));

  const rejectedPayments = await invoiceRepo.count({
    where: { status: InvoiceStatus.FAILED, createdAt: Between(current.start, current.end) },
  });
  const newSubscribers = await subscriptionRepo.count({
    where: { createdAt: Between(current.start, current.end) },
  });

  const revenueByMonth = months.map((month) => ({
    key: month.key,
    label: month.label,
    revenueCents: sumPaidInRange(paidInvoices, month.start, month.end),
  }));

  res.json({
    activeSubscribers,
    complianceRate: Number(complianceRate.toFixed(1)),
    rejectedPayments,
    monthlyRevenueCents,
    previousRevenueCents,
    growthPercent,
    newSubscribers,
    revenueByMonth,
  });
});

function customerSummary(user?: User | null) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    companyName: user.companyName ?? null,
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
    take: 100,
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
    const latest = [...(user.subscriptions ?? [])].sort(
      (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
    )[0];
    return {
      ...customerSummary(user),
      document: user.document ?? null,
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
  res.json(rows.map((invoice) => ({
    id: invoice.id,
    amountCents: invoice.amountCents,
    status: invoice.status,
    dueDate: invoice.dueDate,
    paidAt: invoice.paidAt,
    createdAt: invoice.createdAt,
    gatewayInvoiceId: invoice.gatewayInvoiceId,
    plan: planSummary(invoice.subscription?.plan),
    customer: customerSummary(invoice.subscription?.user),
  })));
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
