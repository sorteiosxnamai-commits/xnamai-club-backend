const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  reaisToCents,
  asaasMonthlyCents,
  asaasCountsTowardMrr,
  asaasMrrAt,
  asaasOneTimeCents,
  asaasMrrTimeline,
  asaasRejectedCount,
  asaasCreatedCount,
  asaasPaymentRows,
  mapAsaasPaymentStatus,
  combineMrr,
  overdueSubscriptionIds,
} = require('../dist/services/asaas-billing');

const now = new Date('2026-11-10T15:00:00.000Z');
const october = new Date('2026-10-31T23:59:59.000Z');

function subscription(extra = {}) {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    value: 149.97,
    cycle: 'MONTHLY',
    status: 'ACTIVE',
    dateCreated: '2026-01-10',
    nextDueDate: '2026-12-10',
    deleted: false,
    ...extra,
  };
}

test('Asaas amounts use cents and normalize the subscription cycle', () => {
  assert.equal(reaisToCents(19.9), 1990);
  assert.equal(asaasMonthlyCents(subscription()), 14997);
  assert.equal(asaasMonthlyCents(subscription({ value: 120, cycle: 'YEARLY' })), 1000);
  assert.equal(asaasMonthlyCents(subscription({
    value: 100,
    discount: { value: 10, type: 'PERCENTAGE' },
  })), 9000);
  assert.equal(asaasMonthlyCents(subscription({
    value: 19.9,
    discount: { value: 10, type: 'FIXED' },
  })), 990);
});

test('current Asaas MRR keeps active contracts, including overdue charges', () => {
  const active = subscription();
  const overdue = subscription({ id: 'sub_overdue' });
  const rows = [
    active,
    overdue,
    subscription({ id: 'sub_inactive', status: 'INACTIVE' }),
    subscription({ id: 'sub_deleted', deleted: true }),
    subscription({ id: 'sub_future', dateCreated: '2026-12-01' }),
    subscription({ id: 'sub_ended', endDate: '2026-11-01' }),
  ];
  const late = overdueSubscriptionIds([{ id: 'pay_1', subscription: 'sub_overdue', status: 'OVERDUE' }]);
  const result = asaasMrrAt(rows, now, late);
  assert.equal(result.subscribers, 2);
  assert.equal(result.pastDue, 1);
  assert.equal(result.cents, 29994);
  assert.equal(asaasCountsTowardMrr(subscription({ dateCreated: '2026-11-20' }), october), false);
});

test('an Asaas subscription created before a past month still counts in that snapshot', () => {
  const timeline = asaasMrrTimeline({
    subscriptions: [subscription({ dateCreated: '2026-08-01' })],
    payments: [],
    customers: [],
  }, [{ at: october }, { at: now }], now);
  assert.equal(timeline.points[0], 14997);
  assert.equal(timeline.currentCents, 14997);
});

test('an Asaas subscription inactivated in November still counts in the October snapshot', () => {
  const timeline = asaasMrrTimeline({
    subscriptions: [subscription({ status: 'INACTIVE' })],
    payments: [{ id: 'pay_1', subscription: 'sub_1', status: 'RECEIVED', paymentDate: '2026-11-02' }],
    customers: [],
  }, [{ at: october }], now);
  assert.equal(timeline.points[0], 14997);
  assert.equal(timeline.subscribers, 0);
  assert.equal(timeline.currentCents, 0);
});

test('a paid Asaas charge is one-time revenue when its contract is outside that month MRR', () => {
  const start = new Date('2026-11-01T03:00:00.000Z');
  const end = new Date('2026-12-01T03:00:00.000Z');
  const cents = asaasOneTimeCents({
    subscriptions: [subscription({ status: 'INACTIVE' }), subscription({ id: 'sub_live' })],
    payments: [
      { id: 'pay_old', subscription: 'sub_1', status: 'RECEIVED', paymentDate: '2026-11-02', value: 149.97 },
      { id: 'pay_live', subscription: 'sub_live', status: 'RECEIVED', paymentDate: '2026-11-03', value: 149.97 },
    ],
    customers: [],
  }, now, start, end, now);
  assert.equal(cents, 14997);
});

test('Asaas payment statuses and rejected charges map into the admin totals', () => {
  assert.equal(mapAsaasPaymentStatus('CONFIRMED'), 'PAID');
  assert.equal(mapAsaasPaymentStatus('RECEIVED_IN_CASH'), 'PAID');
  assert.equal(mapAsaasPaymentStatus('OVERDUE'), 'FAILED');
  assert.equal(mapAsaasPaymentStatus('REFUNDED'), 'CANCELLED');
  assert.equal(mapAsaasPaymentStatus('PENDING'), 'PENDING');

  const payments = [
    { id: 'pay_late', status: 'OVERDUE', dueDate: '2026-11-02', deleted: false },
    { id: 'pay_old', status: 'OVERDUE', dueDate: '2026-10-02', deleted: false },
    { id: 'pay_ok', status: 'RECEIVED', dueDate: '2026-11-02', deleted: false },
    { id: 'pay_removed', status: 'OVERDUE', dueDate: '2026-11-02', deleted: true },
  ];
  const start = new Date('2026-11-01T03:00:00.000Z');
  const end = new Date('2026-12-01T03:00:00.000Z');
  assert.equal(asaasRejectedCount(payments, start, end), 1);
  assert.equal(asaasCreatedCount([
    subscription({ dateCreated: '2026-11-03' }),
    subscription({ id: 'sub_old', dateCreated: '2026-10-03' }),
    subscription({ id: 'sub_removed', dateCreated: '2026-11-04', deleted: true }),
  ], start, end), 1);
});

test('Asaas payments keep the gross value and the customer loaded with the account', () => {
  const rows = asaasPaymentRows({
    subscriptions: [],
    payments: [{
      id: 'pay_1',
      customer: 'cus_1',
      subscription: 'sub_1',
      value: 149.97,
      description: 'Club Launch',
      billingType: 'PIX',
      status: 'RECEIVED',
      dueDate: '2026-11-10',
      paymentDate: '2026-11-10',
      dateCreated: '2026-10-01',
    }],
    customers: [{ id: 'cus_1', name: 'Oficina Norte', email: 'norte@example.com', mobilePhone: '11999999999' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountCents, 14997);
  assert.equal(rows[0].status, 'PAID');
  assert.equal(rows[0].provider, 'asaas');
  assert.equal(rows[0].customer.name, 'Oficina Norte');
  assert.match(rows[0].description, /Pix · Asaas$/);
});

test('Stripe and Asaas MRR timelines add up without dropping a month', () => {
  const combined = combineMrr([
    { currentCents: 1000, subscribers: 1, pastDue: 0, points: [800, 1000] },
    { currentCents: 500, subscribers: 2, pastDue: 1, points: [500, 400] },
  ]);
  assert.deepEqual(combined, {
    currentCents: 1500,
    subscribers: 3,
    pastDue: 1,
    points: [1300, 1400],
  });
  assert.equal(combineMrr([null, undefined]), null);
});
