const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionMonthlyCents, countsTowardMrr, mrrAt } = require('../dist/services/stripe-mrr');

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

test('yearly prices are normalized to a month and forever discounts apply', () => {
  assert.equal(subscriptionMonthlyCents({
    status: 'active',
    items: { data: [{ quantity: 1, price: { unit_amount: 120000, currency: 'brl', recurring: { interval: 'year', interval_count: 1 } } }] },
    discount: { coupon: { percent_off: 10, duration: 'forever' } },
  }), 9000);
});
