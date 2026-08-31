import { In } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { Plan } from '../entities/Plan';
import { User } from '../entities/User';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';

const MONTHS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const FORECAST_STATUSES = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAYMENT_FAILED,
];

export type ForecastMonth = { key: string; label: string; revenueCents: number };
export type UpcomingCharge = {
  id: string;
  dueDate: string;
  amountCents: number;
  status: 'UPCOMING';
  plan: { id: string; code: string; name: string; monthlyPriceCents: number | null } | null;
  customer: { id: string; name: string; email: string; companyName: string | null; phone: string | null } | null;
};

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

function monthMeta(offset = 0, from = new Date()) {
  const current = saoPauloYearMonth(from, offset);
  return {
    key: `${current.year}-${String(current.monthIndex + 1).padStart(2, '0')}`,
    label: `${MONTHS_PT[current.monthIndex]}/${String(current.year).slice(2)}`,
  };
}

function addMonths(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const result = new Date(Date.UTC(year, month, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function nextBillingDate(subscription: Subscription, now: Date) {
  let due = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : addMonths(now, 1);
  if (Number.isNaN(due.getTime())) due = addMonths(now, 1);
  while (due <= now) due = addMonths(due, 1);
  return due;
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

export async function buildRevenueForecast() {
  const now = new Date();
  const subscriptions = await AppDataSource.getRepository(Subscription).find({
    where: { status: In(FORECAST_STATUSES) },
    relations: ['user', 'plan'],
  });

  const upcoming: UpcomingCharge[] = [];
  let monthlyRecurringCents = 0;
  for (const subscription of subscriptions) {
    const amountCents = subscription.plan?.monthlyPriceCents ?? 0;
    if (amountCents <= 0) continue;
    monthlyRecurringCents += amountCents;
    upcoming.push({
      id: subscription.id,
      dueDate: nextBillingDate(subscription, now).toISOString(),
      amountCents,
      status: 'UPCOMING',
      plan: planSummary(subscription.plan),
      customer: customerSummary(subscription.user),
    });
  }
  upcoming.sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate));

  const forecastByMonth: ForecastMonth[] = Array.from({ length: 12 }, (_, index) => ({
    ...monthMeta(index + 1, now),
    revenueCents: monthlyRecurringCents,
  }));

  return {
    forecastSubscribers: upcoming.length,
    nextMonthForecastCents: monthlyRecurringCents,
    yearForecastCents: monthlyRecurringCents * 12,
    forecastByMonth,
    upcomingCharges: upcoming,
  };
}
