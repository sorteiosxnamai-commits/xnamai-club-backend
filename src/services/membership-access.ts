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

export function membershipAccess(
  subscription: Pick<Subscription, 'status' | 'currentPeriodEnd'> | null | undefined,
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

  if (subscription.status === SubscriptionStatus.CANCELLED) {
    return {
      active: false,
      validUntil: asDate(subscription.currentPeriodEnd) ?? paidUntil,
      renewed,
      renewedAt,
    };
  }

  const validUntil = subscription.status === SubscriptionStatus.ACTIVE
    ? asDate(subscription.currentPeriodEnd) ?? paidUntil
    : paidUntil;

  const active = validUntil
    ? validUntil.getTime() > Date.now()
    : subscription.status === SubscriptionStatus.ACTIVE;

  return { active, validUntil, renewed, renewedAt };
}
