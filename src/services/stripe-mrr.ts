import type Stripe from 'stripe';
import { stripe } from '../config/stripe';

const INCLUDED_NOW = new Set(['active', 'past_due']);
const EXCLUDED = new Set(['incomplete', 'incomplete_expired', 'unpaid']);

export type MrrSubscription = {
  id?: string;
  status: string;
  start_date?: number | null;
  trial_end?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  pause_collection?: unknown | null;
  discount?: { coupon?: { percent_off?: number | null; amount_off?: number | null; duration?: string | null } | null } | null;
  items?: {
    data?: Array<{
      quantity?: number | null;
      price?: {
        unit_amount?: number | null;
        currency?: string | null;
        recurring?: { interval?: string | null; interval_count?: number | null } | null;
      } | string | null;
    }>;
  } | null;
};

export function subscriptionMonthlyCents(subscription: MrrSubscription) {
  let total = 0;
  for (const item of subscription.items?.data ?? []) {
    const price = item.price;
    if (!price || typeof price === 'string' || price.unit_amount == null) continue;
    if (price.currency && price.currency !== 'brl') continue;
    const quantity = item.quantity ?? 1;
    const interval = price.recurring?.interval ?? 'month';
    const count = price.recurring?.interval_count || 1;
    const amount = price.unit_amount * quantity;
    if (interval === 'year') total += amount / (12 * count);
    else if (interval === 'week') total += (amount * 4.345) / count;
    else if (interval === 'day') total += (amount * 30) / count;
    else total += amount / count;
  }
  const coupon = subscription.discount?.coupon;
  if (coupon?.percent_off) total *= 1 - coupon.percent_off / 100;
  if (coupon?.amount_off && coupon.duration === 'forever') total -= coupon.amount_off;
  return Math.max(0, Math.round(total));
}

function startedAt(subscription: MrrSubscription) {
  const start = (subscription.start_date ?? 0) * 1000;
  const trialEnd = subscription.trial_end ? subscription.trial_end * 1000 : 0;
  return Math.max(start, trialEnd);
}

export function countsTowardMrr(subscription: MrrSubscription, at: Date, now = at) {
  if (EXCLUDED.has(subscription.status)) return false;
  if (startedAt(subscription) > at.getTime()) return false;
  const ended = (subscription.ended_at ?? subscription.canceled_at ?? 0) * 1000;
  if (ended && ended <= at.getTime()) return false;
  const current = at.getTime() >= now.getTime() - 1000;
  if (current && subscription.pause_collection) return false;
  if (current && !INCLUDED_NOW.has(subscription.status)) return false;
  return subscriptionMonthlyCents(subscription) > 0;
}

export function mrrAt(subscriptions: MrrSubscription[], at: Date, now = at) {
  let cents = 0;
  let subscribers = 0;
  let pastDue = 0;
  for (const subscription of subscriptions) {
    if (!countsTowardMrr(subscription, at, now)) continue;
    cents += subscriptionMonthlyCents(subscription);
    subscribers += 1;
    if (subscription.status === 'past_due') pastDue += 1;
  }
  return { cents, subscribers, pastDue };
}

export type PaidCharge = {
  paidAt?: Date | string | null;
  createdAt?: Date | string | null;
  amountCents: number;
  gatewaySubscriptionId?: string | null;
};

function chargeInstant(charge: PaidCharge) {
  const value = charge.paidAt ?? charge.createdAt;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Paid charges whose contract is not in the MRR snapshot for that month. */
export function oneTimeCents(
  subscriptions: MrrSubscription[],
  charges: PaidCharge[],
  at: Date,
  start: Date,
  end: Date,
  now = at,
) {
  const recurring = new Set(
    subscriptions
      .filter((subscription) => subscription.id && countsTowardMrr(subscription, at, now))
      .map((subscription) => subscription.id as string),
  );
  let cents = 0;
  for (const charge of charges) {
    const paid = chargeInstant(charge);
    if (!paid || paid < start || paid >= end || charge.amountCents <= 0) continue;
    if (charge.gatewaySubscriptionId && recurring.has(charge.gatewaySubscriptionId)) continue;
    cents += charge.amountCents;
  }
  return cents;
}

let cached: { at: number; rows: Stripe.Subscription[] } | null = null;

async function listSubscriptions() {
  if (!stripe) return null;
  if (cached && Date.now() - cached.at < 60_000) return cached.rows;
  const rows: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  while (rows.length < 2000) {
    const page = await stripe.subscriptions.list({
      limit: 100,
      status: 'all',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    rows.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  }
  cached = { at: Date.now(), rows };
  return rows;
}

export async function loadStripeSubscriptions() {
  return listSubscriptions();
}

export async function loadStripeMrrTimeline(points: Array<{ at: Date }>) {
  const rows = await listSubscriptions();
  if (!rows) return null;
  const now = new Date();
  const current = mrrAt(rows, now, now);
  return {
    currentCents: current.cents,
    subscribers: current.subscribers,
    pastDue: current.pastDue,
    points: points.map((point) => mrrAt(rows, point.at, now).cents),
  };
}
