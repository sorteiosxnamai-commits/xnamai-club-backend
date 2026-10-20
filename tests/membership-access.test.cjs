const { test } = require('node:test');
const assert = require('node:assert/strict');
const { membershipAccess, pickPrimarySubscription } = require('../dist/services/membership-access');
const { SubscriptionStatus } = require('../dist/entities/Subscription');
const { InvoiceStatus } = require('../dist/entities/Invoice');

function paidInvoice(paidAt) {
  return { status: InvoiceStatus.PAID, paidAt, createdAt: paidAt };
}

function addDays(from, days) {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

test('duplicate checkout: desk uses the kept paid subscription, not the later cancelled one', () => {
  const created = addDays(new Date(), -42);
  const duplicateAt = new Date(created.getTime() + 2 * 60 * 60 * 1000);
  const renewalPaidAt = addDays(new Date(), -12);

  const kept = {
    id: 'kept',
    status: SubscriptionStatus.ACTIVE,
    createdAt: created,
    currentPeriodStart: created,
    currentPeriodEnd: addDays(created, 30),
    invoices: [paidInvoice(created), paidInvoice(renewalPaidAt)],
  };
  const duplicate = {
    id: 'duplicate',
    status: SubscriptionStatus.CANCELLED,
    createdAt: duplicateAt,
    currentPeriodStart: duplicateAt,
    currentPeriodEnd: addDays(duplicateAt, 30),
    invoices: [paidInvoice(duplicateAt)],
  };

  const primary = pickPrimarySubscription([duplicate, kept]);
  assert.equal(primary?.id, 'kept');

  const access = membershipAccess(primary, primary.invoices);
  assert.equal(access.active, true);
  assert.equal(access.renewed, true);
  assert.ok(access.validUntil.getTime() > Date.now());
});

test('falls back to the oldest live subscription when none is currently covered', () => {
  const older = {
    id: 'older',
    status: SubscriptionStatus.ACTIVE,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
    invoices: [],
  };
  const newer = {
    id: 'newer',
    status: SubscriptionStatus.CANCELLED,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    currentPeriodStart: new Date('2026-03-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-04-01T00:00:00.000Z'),
    invoices: [],
  };
  assert.equal(pickPrimarySubscription([newer, older])?.id, 'older');
  assert.equal(pickPrimarySubscription([]), undefined);
});
