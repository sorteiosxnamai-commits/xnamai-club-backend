const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionMonthlyCents, countsTowardMrr, mrrAt, oneTimeCents } = require('../dist/services/stripe-mrr');

const now = new Date('2026-11-05T12:00:00.000Z');
const october = new Date('2026-10-31T23:59:59.000Z');

function monthly(status, extra = {}) {
  return {
    status,
    start_date: 1_700_000_000,
    items: { data: [{ quantity: 1, price: { unit_amount: 14997, currency: 'brl', recurring: { interval: 'month', interval_count: 1 } } }] },
    ...extra,
  };
}

test('current MRR includes active and past due subscriptions only', () => {
  const result = mrrAt([
    monthly('active'),
    monthly('past_due'),
    monthly('active', { pause_collection: { behavior: 'void' } }),
    monthly('trialing'),
    monthly('canceled', { canceled_at: 1_700_000_100 }),
    monthly('incomplete'),
  ], now, now);
  assert.equal(result.subscribers, 2);
  assert.equal(result.cents, 29994);
});

test('a subscription canceled in November still counts in the October snapshot', () => {
  const canceled = monthly('canceled', { canceled_at: Math.floor(new Date('2026-11-02T00:00:00.000Z').getTime() / 1000) });
  assert.equal(countsTowardMrr(canceled, october, now), true);
  assert.equal(countsTowardMrr(canceled, now, now), false);
});

test('a payment in the cancel month is one-time revenue and is not counted twice while the contract is still in MRR', () => {
  const canceled = monthly('canceled', {
    id: 'sub_cancel',
    canceled_at: Math.floor(new Date('2026-11-02T00:00:00.000Z').getTime() / 1000),
  });
  const active = monthly('active', { id: 'sub_live' });
  const charges = [
    { paidAt: new Date('2026-11-01T12:00:00.000Z'), amountCents: 14997, gatewaySubscriptionId: 'sub_cancel' },
    { paidAt: new Date('2026-11-03T12:00:00.000Z'), amountCents: 14997, gatewaySubscriptionId: 'sub_live' },
    { paidAt: new Date('2026-10-20T12:00:00.000Z'), amountCents: 5000, gatewaySubscriptionId: null },
  ];
  const novemberStart = new Date('2026-11-01T03:00:00.000Z');
  const decemberStart = new Date('2026-12-01T03:00:00.000Z');
  assert.equal(oneTimeCents([canceled, active], charges, now, novemberStart, decemberStart, now), 14997);
  const octoberStart = new Date('2026-10-01T03:00:00.000Z');
  assert.equal(oneTimeCents([canceled, active], charges, october, octoberStart, novemberStart, now), 5000);
});

test('yearly prices are normalized to a month and forever discounts apply', () => {
  assert.equal(subscriptionMonthlyCents({
    status: 'active',
    items: { data: [{ quantity: 1, price: { unit_amount: 120000, currency: 'brl', recurring: { interval: 'year', interval_count: 1 } } }] },
    discount: { coupon: { percent_off: 10, duration: 'forever' } },
  }), 9000);
});
