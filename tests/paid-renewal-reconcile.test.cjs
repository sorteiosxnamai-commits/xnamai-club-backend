const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AppDataSource } = require('../dist/config/data-source');
const config = require('../dist/config/stripe');
const { repairPaidThroughSubscriptions } = require('../dist/services/stripe-billing');
const { membershipAccess } = require('../dist/services/membership-access');

test('refresh discovers a newly paid invoice on an old canceled subscription despite an expired local invoice', async () => {
  const originalRepo = AppDataSource.getRepository;
  const originalStripe = config.stripe;
  const now = new Date();
  const old = new Date(now.getTime() - 60 * 86400000);
  const subscription = { id: 'local', status: 'CANCELLED', gatewaySubscriptionId: 'sub_old',
    currentPeriodStart: old, currentPeriodEnd: new Date(old.getTime() + 30 * 86400000), cancelledAt: old };
  const invoices = [{ gatewayInvoiceId: 'in_old', subscription, status: 'PAID', paidAt: old, dueDate: old }];
  let stripeQueries = 0;
  const builder = {};
  for (const method of ['leftJoin', 'where', 'andWhere']) builder[method] = () => builder;
  builder.getMany = async () => [subscription];
  const repos = {
    Subscription: { createQueryBuilder: () => builder, save: async (row) => row },
    Invoice: {
      findOne: async ({ where }) => where.gatewayInvoiceId
        ? invoices.find((invoice) => invoice.gatewayInvoiceId === where.gatewayInvoiceId) ?? null
        : [...invoices].sort((a, b) => b.paidAt - a.paidAt)[0],
      create: (row) => row,
      save: async (row) => { if (!invoices.includes(row)) invoices.push(row); return row; },
    },
    PaymentAttempt: { create: (row) => row, save: async (row) => row },
  };
  AppDataSource.getRepository = (entity) => repos[entity.name];
  config.stripe = { invoices: { list: async ({ subscription: id }) => {
    stripeQueries++;
    assert.equal(id, 'sub_old');
    return { data: [{ id: 'in_renewal', status: 'paid', amount_paid: 14997,
      created: Math.floor(old.getTime() / 1000), status_transitions: { paid_at: Math.floor(now.getTime() / 1000) } }] };
  } } };
  try {
    await repairPaidThroughSubscriptions();
    assert.equal(subscription.status, 'CANCELLED');
    assert.equal(stripeQueries, 0);
    await repairPaidThroughSubscriptions(true);
    assert.equal(stripeQueries, 1);
    assert.equal(subscription.status, 'ACTIVE');
    assert.ok(subscription.currentPeriodEnd > now);
    const until = subscription.currentPeriodEnd.toISOString();
    await repairPaidThroughSubscriptions(true);
    assert.equal(subscription.currentPeriodEnd.toISOString(), until);
    assert.equal(invoices.length, 2);
    const access = membershipAccess({ ...subscription, status: 'CANCELLED' }, invoices);
    assert.equal(access.active, true);
    assert.equal(access.renewed, true);
  } finally {
    AppDataSource.getRepository = originalRepo;
    config.stripe = originalStripe;
  }
});
