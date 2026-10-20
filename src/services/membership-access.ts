import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';

export type MembershipAccess = {
  active: boolean;
  validUntil: Date | null;
  renewed: boolean;
  renewedAt: Date | null;
};

const emptyAccess: MembershipAccess = {
  active: false,
  validUntil: null,
  renewed: false,
  renewedAt: null,
};

function asDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addCalendarMonth(from: Date) {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}

const HOUR_MS = 60 * 60 * 1000;

function openPeriodEnd(start: Date | null, end: Date | null) {
  if (start && end && end.getTime() <= start.getTime() + HOUR_MS) return addCalendarMonth(start);
  return end;
}

export type SubscriptionForAccess = Pick<
  Subscription,
  'status' | 'currentPeriodStart' | 'currentPeriodEnd' | 'createdAt'
> & {
  invoices?: Array<Pick<Invoice, 'status' | 'paidAt' | 'createdAt'>>;
};

function liveliness(status: SubscriptionStatus) {
  if (
    status === SubscriptionStatus.ACTIVE
    || status === SubscriptionStatus.PAST_DUE
    || status === SubscriptionStatus.PAYMENT_FAILED
    || status === SubscriptionStatus.SUSPENDED
  ) {
    return 2;
  }
  if (status === SubscriptionStatus.PENDING) return 1;
  return 0;
}

export function membershipAccess(
  subscription: Pick<Subscription, 'status' | 'currentPeriodStart' | 'currentPeriodEnd'> | null | undefined,
  invoices: Array<Pick<Invoice, 'status' | 'paidAt' | 'createdAt'>> = [],
): MembershipAccess {
  if (!subscription || subscription.status === SubscriptionStatus.PENDING) return emptyAccess;

  const paid = invoices
    .filter((invoice) => invoice.status === InvoiceStatus.PAID)
    .map((invoice) => asDate(invoice.paidAt) ?? asDate(invoice.createdAt))
    .filter((paidAt): paidAt is Date => Boolean(paidAt))
    .sort((a, b) => b.getTime() - a.getTime());

  const renewed = paid.length >= 2;
  const renewedAt = renewed ? paid[0] : null;
  const paidUntil = paid[0] ? addCalendarMonth(paid[0]) : null;
  const periodEnd = openPeriodEnd(asDate(subscription.currentPeriodStart), asDate(subscription.currentPeriodEnd));
  const validUntil = [periodEnd, paidUntil]
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  if (subscription.status === SubscriptionStatus.CANCELLED) {
    return { active: false, validUntil, renewed, renewedAt };
  }

  const active = validUntil
    ? validUntil.getTime() > Date.now()
    : subscription.status === SubscriptionStatus.ACTIVE;

  return { active, validUntil, renewed, renewedAt };
}

export function pickPrimarySubscription<T extends SubscriptionForAccess>(
  subscriptions: T[] | null | undefined,
): T | undefined {
  if (!subscriptions?.length) return undefined;

  return [...subscriptions].sort((a, b) => {
    const accessA = membershipAccess(a, a.invoices ?? []);
    const accessB = membershipAccess(b, b.invoices ?? []);
    if (accessA.active !== accessB.active) return Number(accessB.active) - Number(accessA.active);

    const live = liveliness(b.status) - liveliness(a.status);
    if (live) return live;

    const untilA = accessA.validUntil?.getTime() ?? 0;
    const untilB = accessB.validUntil?.getTime() ?? 0;
    if (untilA !== untilB) return untilB - untilA;

    return +new Date(a.createdAt) - +new Date(b.createdAt);
  })[0];
}
