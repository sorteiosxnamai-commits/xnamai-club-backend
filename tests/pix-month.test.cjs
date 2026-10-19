const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PIX_MONTH_PRICE_CENTS, pixCheckoutIsPaid, pixMonthWindow, subscriptionToKeep } = require('../dist/services/stripe-billing');
const { SubscriptionStatus } = require('../dist/entities/Subscription');

test('pix month is charged at R$ 199,97', () => {
  assert.equal(PIX_MONTH_PRICE_CENTS, 19997);
});

test('keeps the oldest stripe subscription when duplicates exist', () => {
  const keep = subscriptionToKeep([
    { id: 'sub_new', created: 200 },
    { id: 'sub_old', created: 100 },
    { id: 'sub_mid', created: 150 },
  ]);
  assert.equal(keep?.id, 'sub_old');
  assert.equal(subscriptionToKeep([]), null);
});

test('pix checkout grants access only after Stripe marks the payment as paid', () => {
  const paid = {
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    metadata: { purpose: 'pix_month' },
  };
  assert.equal(pixCheckoutIsPaid(paid), true);
  assert.equal(pixCheckoutIsPaid({ ...paid, payment_status: 'unpaid' }), false);
  assert.equal(pixCheckoutIsPaid({ ...paid, mode: 'subscription' }), false);
  assert.equal(pixCheckoutIsPaid({ ...paid, metadata: {} }), false);
});

test('one-time pix expires on the entry anniversary and restarts after the due date', () => {
  const paidAt = new Date('2026-10-13T17:09:00.000Z');
  const first = pixMonthWindow(paidAt, {
    status: SubscriptionStatus.PENDING,
    currentPeriodStart: null,
    currentPeriodEnd: null,
  });
  assert.equal(first.periodStart.toISOString(), paidAt.toISOString());
  assert.equal(first.periodEnd.toISOString(), '2026-11-13T17:09:00.000Z');

  const early = new Date('2026-11-10T12:00:00.000Z');
  const renewed = pixMonthWindow(early, {
    status: SubscriptionStatus.ACTIVE,
    currentPeriodStart: first.periodStart,
    currentPeriodEnd: first.periodEnd,
  });
  assert.equal(renewed.periodStart.toISOString(), first.periodStart.toISOString());
  assert.equal(renewed.periodEnd.toISOString(), '2026-12-13T17:09:00.000Z');

  const late = new Date('2026-12-20T08:30:00.000Z');
  const restarted = pixMonthWindow(late, {
    status: SubscriptionStatus.ACTIVE,
    currentPeriodStart: renewed.periodStart,
    currentPeriodEnd: renewed.periodEnd,
  });
  assert.equal(restarted.periodStart.toISOString(), late.toISOString());
  assert.equal(restarted.periodEnd.toISOString(), '2027-01-20T08:30:00.000Z');
});
