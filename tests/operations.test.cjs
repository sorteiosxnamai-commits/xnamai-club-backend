const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
process.env.DB_TYPE = 'sqlite';
process.env.DB_PATH = path.join(__dirname, '..', 'data', `operations-${process.pid}.sqlite`);
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.STRIPE_SECRET_KEY = '';
process.env.REDIS_URL = '';
const { AppDataSource: db } = require('../dist/config/data-source');
const { createApp } = require('../dist/server');
const { User } = require('../dist/entities/User');
const { Plan } = require('../dist/entities/Plan');
const { Subscription } = require('../dist/entities/Subscription');
const { Invoice } = require('../dist/entities/Invoice');
const { PaymentMethod } = require('../dist/entities/PaymentMethod');
const { signAccessToken } = require('../dist/middleware/auth');
const { seedInitialData } = require('../dist/services/seed');
let server, base, admin, support, customer;
const token = user => signAccessToken({ sub: user.id, email: user.email, role: user.role });
const request = (route, user, method = 'GET') => fetch(base + route, { method, headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
before(async () => {
  await db.initialize(); await seedInitialData();
  const repo = db.getRepository(User);
  admin = await repo.findOneByOrFail({ email: 'admin@xnamai.local' }); support = await repo.findOneByOrFail({ role: 'SUPPORT' });
  customer = await repo.save({ email: 'customer@ops.invalid', passwordHash: 'unused', role: 'CUSTOMER', name: 'Cliente', companyName: 'Loja Ops', document: '04252011000110' });
  server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.destroy(); fs.rmSync(process.env.DB_PATH, { force: true }); });

test('atendimento lists members without login', async () => {
  assert.equal((await request('/atendimento/members', null)).status, 200);
  assert.equal((await request('/atendimento/members', customer)).status, 200);
  assert.equal((await request('/atendimento/members', support)).status, 200);
  assert.equal((await request('/atendimento/members', admin)).status, 200);
});
test('a revoked staff role immediately invalidates an already issued token', async () => {
  const stale = token(support);
  await db.getRepository(User).update(support.id, { role: 'CUSTOMER' });
  const response = await fetch(base + `/auth/users/${customer.id}/reset-password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stale}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'NovaSenhaForte123!' }),
  });
  assert.equal(response.status, 401);
  await db.getRepository(User).update(support.id, { role: 'SUPPORT' });
});
test('boot never overwrites existing privileged credentials or changes their email', async () => {
  const repo = db.getRepository(User);
  await repo.update(admin.id, { passwordHash: 'changed-locally', email: 'changed-admin@ops.invalid' });
  process.env.ADMIN_EMAIL = 'another-admin@ops.invalid'; process.env.ADMIN_PASSWORD = 'Different123!';
  const plans = db.getRepository(Plan);
  const custom = await plans.findOneByOrFail({ code: 'LAUNCH' });
  await plans.update(custom.id, { active: false, monthlyPriceCents: 9900 });
  await seedInitialData();
  const existing = await repo.findOneByOrFail({ id: admin.id });
  assert.equal(existing.passwordHash, 'changed-locally'); assert.equal(existing.email, 'changed-admin@ops.invalid');
  const clubAdmin = await repo.findOneByOrFail({ email: 'admin@xnamai.com' });
  assert.equal(clubAdmin.role, 'ADMIN');
  assert.equal(await repo.count({ where: { role: 'ADMIN' } }), 2);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@xnamai.com', password: '12345678' }),
  });
  assert.equal(login.status, 200);
  const preserved = await plans.findOneByOrFail({ id: custom.id });
  assert.equal(preserved.active, false); assert.equal(preserved.monthlyPriceCents, 9900);
  await plans.update(custom.id, { active: true, monthlyPriceCents: 14997 });
  delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD;
});
test('forecasts use verified recurring amounts and exclude one-time PIX and canceled renewal', async () => {
  const plan = await db.getRepository(Plan).findOneByOrFail({ code: 'LAUNCH' });
  const make = async (suffix, amount, method, cancelled = false) => {
    const user = await db.getRepository(User).save({ email: `${suffix}@ops.invalid`, name: suffix, passwordHash: 'unused', role: 'CUSTOMER' });
    const subscription = await db.getRepository(Subscription).save({ user, plan, status: 'ACTIVE', billingAmountCents: amount, gatewaySubscriptionId: method === 'PIX_RECURRING' ? null : `sub_${suffix}`, currentPeriodEnd: new Date(Date.now() + 86400000), cancelledAt: cancelled ? new Date() : null });
    await db.getRepository(PaymentMethod).save({ user, type: method, provider: 'stripe', providerPaymentMethodId: suffix, active: true });
    await db.getRepository(Invoice).save({ subscription, amountCents: 350, status: 'PAID', dueDate: new Date(), paidAt: new Date() });
  };
  await make('card', 12900, 'CREDIT_CARD'); await make('boleto', 18900, 'BOLETO');
  await make('pix', 19999, 'PIX_RECURRING'); await make('canceled', 14997, 'CREDIT_CARD', true);
  const { buildRevenueForecast } = require('../dist/services/revenue-forecast');
  const forecast = await buildRevenueForecast();
  assert.equal(forecast.nextMonthForecastCents, 31800); assert.equal(forecast.forecastSubscribers, 2);
});

test('legacy PIX checkout charges the selected plan, not a shared Basic price', async () => {
  const config = require('../dist/config/stripe');
  const original = config.requireStripe;
  const amounts = [];
  config.requireStripe = () => ({
    customers: { create: async () => ({ id: 'cus_ops' }), retrieve: async () => ({ id: 'cus_ops' }) },
    checkout: { sessions: { create: async params => { amounts.push(params.line_items[0].price_data.unit_amount); return { id: 'cs_ops', url: 'https://checkout.stripe.com/ops', payment_method_types: ['pix'] }; } } },
  });
  try {
    for (const code of ['LAUNCH', 'PRIORITY']) {
      const plan = await db.getRepository(Plan).findOneByOrFail({ code });
      const result = await fetch(base + '/subscriptions/checkout', { method: 'POST', headers: { Authorization: `Bearer ${token(customer)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: plan.id, paymentMethodType: 'PIX_RECURRING' }) });
      assert.equal(result.status, 200);
    }
    assert.deepEqual(amounts, [19999, 34999]);
  } finally { config.requireStripe = original; }
});

test('concurrent requests cannot reserve the last Fast Pass seat twice', async () => {
  const { reservePrioritySeat, releasePrioritySeat, priorityAvailability } = require('../dist/services/priority-capacity');
  const { PriorityReservation } = require('../dist/entities/PriorityReservation');
  await db.getRepository(PriorityReservation).delete({ userId: customer.id });
  const plan = await db.getRepository(Plan).findOneByOrFail({ code: 'PRIORITY' });
  const users = await db.getRepository(User).save(Array.from({ length: 51 }, (_, i) => ({ email: `seat${i}@ops.invalid`, name: `Seat ${i}`, companyName: 'Loja Ops', document: '04252011000110', role: 'CUSTOMER', passwordHash: 'unused' })));
  await db.getRepository(Subscription).save(users.slice(0, 49).map(user => ({ user, plan, status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86400000) })));
  const result = await Promise.allSettled(users.slice(49).map(user => reservePrioritySeat(user.id)));
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(result.filter(row => row.status === 'rejected').length, 1);
  assert.equal((await priorityAvailability()).remaining, 0);
  const rejected = users.slice(49)[result.findIndex(row => row.status === 'rejected')];
  const response = await fetch(base + '/subscriptions/payment-link', { method: 'POST', headers: { Authorization: `Bearer ${token(rejected)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'PRIORITY', method: 'PIX' }) });
  assert.equal(response.status, 409);
  const held = users.slice(49)[result.findIndex(row => row.status === 'fulfilled')];
  await db.getRepository(PriorityReservation).update({ userId: held.id }, { expiresAt: new Date(Date.now() - 60000) });
  assert.equal((await priorityAvailability()).remaining, 1);
});

test('Asaas link selection is authenticated and does not call an external payment API', async () => {
  const response = await fetch(base + '/subscriptions/payment-link', { method: 'POST', headers: { Authorization: `Bearer ${token(customer)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'LAUNCH', method: 'PIX' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://www.asaas.com/000/c/o1ec2qy62xy2osok', amountCents: 19999 });
  assert.equal((await request('/subscriptions/payment-link', null, 'POST')).status, 401);
  assert.equal((await request('/subscriptions/payment-link', support, 'POST')).status, 403);
});

test('canceling one checkout attempt cannot remove another attempt reservation', async () => {
  const { reservePrioritySeat, releasePrioritySeat, priorityAvailability } = require('../dist/services/priority-capacity');
  const a = await reservePrioritySeat(customer.id);
  const b = await reservePrioritySeat(customer.id);
  assert.notEqual(a, b);
  await releasePrioritySeat(a);
  assert.equal((await priorityAvailability()).remaining, 0);
  await releasePrioritySeat(b);
  assert.equal((await priorityAvailability()).remaining, 1);
});

test('canceled and pending contracts without payment do not occupy a permanent seat', async () => {
  const { priorityAvailability } = require('../dist/services/priority-capacity');
  const plan = await db.getRepository(Plan).findOneByOrFail({ code: 'PRIORITY' });
  const before = await priorityAvailability();
  await db.getRepository(Subscription).save(['CANCELLED', 'PENDING'].map(status => ({ user: customer, plan, status, currentPeriodEnd: new Date(Date.now() + 86400000) })));
  assert.deepEqual(await priorityAvailability(), before);
});

test('late Stripe payment cannot activate client 51 after a reservation expires', async () => {
  const plan = await db.getRepository(Plan).findOneByOrFail({ code: 'PRIORITY' });
  const user = await db.getRepository(User).save({ email: 'last-occupied@ops.invalid', name: 'Última vaga', role: 'CUSTOMER', passwordHash: 'unused' });
  await db.getRepository(Subscription).save({ user, plan, status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86400000) });
  const { upsertLocalSubscription } = require('../dist/services/stripe-billing');
  await assert.rejects(() => upsertLocalSubscription({ user: customer, plan, stripeSubscription: {
    id: 'sub_late', customer: 'cus_late', status: 'active', start_date: Math.floor(Date.now() / 1000),
    items: { data: [{ price: { unit_amount: 29797 }, quantity: 1 }] },
  } }), /50 vagas/);
  assert.equal(await db.getRepository(Subscription).count({ where: { gatewaySubscriptionId: 'sub_late' } }), 0);
});

test('an unverified legacy amount never repeats a proportional invoice as monthly revenue', async () => {
  const plan = await db.getRepository(Plan).findOneByOrFail({ code: 'LAUNCH' });
  const user = await db.getRepository(User).save({ email: 'unverified@ops.invalid', name: 'Valor a conferir', role: 'CUSTOMER', passwordHash: 'unused' });
  const subscription = await db.getRepository(Subscription).save({ user, plan, status: 'ACTIVE', gatewaySubscriptionId: 'sub_unverified' });
  await db.getRepository(Invoice).save({ subscription, amountCents: 350, status: 'PAID', dueDate: new Date(), paidAt: new Date() });
  const { buildRevenueForecast } = require('../dist/services/revenue-forecast');
  const forecast = await buildRevenueForecast();
  assert.equal(forecast.nextMonthForecastCents, 31800);
  assert.equal(forecast.unpricedSubscribers, 1);
});
