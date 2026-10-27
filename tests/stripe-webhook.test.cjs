const { test } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { env } = require('../dist/config/env');
const config = require('../dist/config/stripe');
const { stripeWebhookHandler } = require('../dist/routes/webhooks');

test('webhook verifies test signatures without applying test events to production', async () => {
  const original = config.requireStripe;
  const before = { ...env.stripe };
  const client = new Stripe('sk_test_fixture');
  config.requireStripe = () => client;
  env.stripe.secretKey = 'sk_live_fixture';
  env.stripe.webhookSecret = 'whsec_live_fixture';
  env.stripe.testWebhookSecret = 'whsec_test_fixture';
  async function deliver(secret, livemode, type = 'customer.subscription.updated') {
    const payload = JSON.stringify({ id: 'evt_fixture', object: 'event', type, livemode,
      data: { object: { metadata: { userId: 'must_not_query_database', planId: 'test' } } } });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret });
    const result = { status: 200 };
    const response = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
    await stripeWebhookHandler({ body: Buffer.from(payload), headers: { 'stripe-signature': signature } }, response);
    return result;
  }
  try {
    const ignored = await deliver('whsec_test_fixture', false);
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body.ignored, 'mode_mismatch');
    assert.equal((await deliver('whsec_wrong', false)).status, 400);
    assert.equal((await deliver('whsec_live_fixture', true, 'unknown.event')).status, 200);
  } finally {
    config.requireStripe = original;
    Object.assign(env.stripe, before);
  }
});
