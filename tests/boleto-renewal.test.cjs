const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AppDataSource } = require('../dist/config/data-source');
const stripeConfig = require('../dist/config/stripe');
const { applyOneTimePixPayment } = require('../dist/services/stripe-billing');

test('boleto to PIX waits for payment, checks ownership, preserves paid days and is repeatable', async () => {
  const originalRepo = AppDataSource.getRepository;
  const originalStripe = stripeConfig.requireStripe;
  const originalAudit = require('../dist/services/audit').audit;
  const user = { id: 'user', stripeCustomerId: 'cus_owner' };
  const plan = { id: 'plan', monthlyPriceCents: 14997 };
  const previous = { id: 'old', user, plan, status: 'ACTIVE', gatewaySubscriptionId: 'sub_boleto' };
  let latest = previous;
  let recorded = null;
  let cancellations = 0;
  const paidAt = new Date('2026-10-27T12:00:00Z');
  const repos = {
    User: { findOneBy: async () => user },
    Plan: { findOneBy: async () => plan },
    Subscription: {
      findOne: async ({ where }) => where.id ? previous : latest,
      create: (row) => ({ id: 'new', ...row }),
      save: async (row) => { if (row.id !== 'old') latest = row; return row; },
    },
    Invoice: {
      findOne: async () => recorded,
      find: async () => [{ paidAt: new Date('2026-10-15T12:00:00Z') }],
      create: (row) => row,
      save: async (row) => { recorded = row; return row; },
    },
    PaymentMethod: { findOne: async () => null, create: (row) => row, save: async (row) => row, find: async () => [] },
  };
  let customer = 'cus_wrong';
  AppDataSource.getRepository = (entity) => { assert.ok(repos[entity.name], entity.name); return repos[entity.name]; };
  stripeConfig.requireStripe = () => ({
    paymentIntents: { retrieve: async () => ({ created: paidAt.getTime() / 1000 }) },
    subscriptions: {
      retrieve: async () => ({ id: 'sub_boleto', customer, status: 'active' }),
      cancel: async () => { cancellations++; },
    },
  });
  require('../dist/services/audit').audit = async () => {};
  const session = { id: 'cs_pix', mode: 'payment', status: 'complete', payment_status: 'unpaid', customer: 'cus_owner',
    payment_intent: 'pi_paid', amount_total: 19997,
    metadata: { purpose: 'pix_month', userId: 'user', planId: 'plan', replacesBoletoSubscriptionId: 'old' } };
  try {
    await assert.rejects(applyOneTimePixPayment(session), /ainda não confirmado/);
    assert.equal(cancellations, 0);
    session.payment_status = 'paid';
    await assert.rejects(applyOneTimePixPayment(session), /não pertence/);
    assert.equal(cancellations, 0);
    customer = 'cus_owner';
    const result = await applyOneTimePixPayment(session);
    assert.equal(cancellations, 1);
    assert.equal(previous.status, 'CANCELLED');
    assert.equal(result.gatewaySubscriptionId, null);
    assert.equal(result.status, 'ACTIVE');
    assert.equal(result.currentPeriodEnd.toISOString(), '2026-12-15T12:00:00.000Z');
    assert.equal((await applyOneTimePixPayment(session)).id, result.id);
    assert.equal(cancellations, 1);
  } finally {
    AppDataSource.getRepository = originalRepo;
    stripeConfig.requireStripe = originalStripe;
    require('../dist/services/audit').audit = originalAudit;
  }
});
