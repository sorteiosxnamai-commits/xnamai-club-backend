const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { spawnSync } = require('node:child_process');

const dbPath = path.join(__dirname, '..', 'data', `contract-${process.pid}.sqlite`);
process.env.DB_PATH = dbPath;
process.env.DB_TYPE = 'sqlite';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = 'local-contract-test-secret';
process.env.STRIPE_SECRET_KEY = '';
process.env.REDIS_URL = '';

const { AppDataSource } = require('../dist/config/data-source');
const { Plan } = require('../dist/entities/Plan');
const { Subscription, SubscriptionStatus } = require('../dist/entities/Subscription');
const { User } = require('../dist/entities/User');
const { UserRole } = require('../dist/entities/User');
const { signAccessToken } = require('../dist/middleware/auth');
const { createApp } = require('../dist/server');
const { authRouter } = require('../dist/routes/auth');
const { plansRouter } = require('../dist/routes/plans');
const { subscriptionsRouter } = require('../dist/routes/subscriptions');
const { customerRouter } = require('../dist/routes/customer');
const { atendimentoRouter } = require('../dist/routes/atendimento');

test('production refuses to start without JWT_SECRET', () => {
  const child = spawnSync(process.execPath, ['-e', "require('./dist/config/env')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '' },
    encoding: 'utf8',
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /JWT_SECRET must be configured in production/);
});

test('real Club routes: auth, plans, subscription, dashboard and member state', async () => {
  await AppDataSource.initialize();
  const app = createApp();
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  async function request(route, options = {}) {
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    const invalid = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Teste' }) });
    assert.equal(invalid.status, 400);
    const profile = { name: 'Cliente Teste', email: 'contract@example.invalid', password: 'SenhaTeste123!',
      city: 'São Paulo', state: 'SP', document: '52998224725' };
    const registered = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(profile) });
    assert.equal(registered.status, 201);
    assert.ok(registered.body.token);
    assert.equal(registered.body.user.document, profile.document);
    token = registered.body.token;
    assert.equal((await request('/api/auth/me')).body.email, profile.email);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: profile.email, password: profile.password }) })).status, 200);

    const plan = await AppDataSource.getRepository(Plan).save({ code: 'LAUNCH', name: 'Plano de teste',
      monthlyPriceCents: 14997, description: '', active: true, sortOrder: 1 });
    const plans = await request('/api/plans');
    assert.equal(plans.status, 200);
    assert.equal(plans.body[0].monthlyPriceCents, 14997);

    assert.equal((await request('/api/subscriptions/me')).status, 404);
    assert.equal((await request('/api/me/dashboard')).body.subscription, null);
    const checkout = await request('/api/subscriptions/checkout', { method: 'POST',
      body: JSON.stringify({ planId: plan.id, paymentMethodType: 'CREDIT_CARD' }) });
    assert.equal(checkout.status, 400); // Stripe absent: no checkout URL invented.

    const user = await AppDataSource.getRepository(User).findOneByOrFail({ email: profile.email });
    await AppDataSource.getRepository(Subscription).save({ user, plan, status: SubscriptionStatus.ACTIVE,
      startedAt: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000) });
    assert.equal((await request('/api/subscriptions/me')).body.status, 'ACTIVE');
    assert.equal((await request('/api/me/dashboard')).body.subscription.status, 'ACTIVE');
    const memberUrl = '/api/atendimento/members';
    const cashbackUrl = `${memberUrl}/${user.id}/cashback-use`;
    const withoutToken = { headers: { Authorization: '' } };
    assert.equal((await request(memberUrl, withoutToken)).status, 200);
    assert.equal((await request(memberUrl)).status, 200);

    const adminToken = signAccessToken({ sub: 'admin-test', email: 'admin@example.invalid', role: UserRole.ADMIN });
    const supportToken = signAccessToken({ sub: 'support-test', email: 'support@example.invalid', role: UserRole.SUPPORT });
    const adminAuth = { headers: { Authorization: `Bearer ${adminToken}` } };
    const supportAuth = { headers: { Authorization: `Bearer ${supportToken}` } };
    const members = await request(`${memberUrl}?refresh=1`, adminAuth);
    assert.equal(members.status, 200);
    assert.equal(members.body.joined[0].email, profile.email);
    assert.equal((await request(memberUrl, supportAuth)).status, 200);
    const cashback = await request(cashbackUrl, { ...withoutToken, method: 'POST' });
    assert.equal(cashback.status, 200);
    assert.equal(cashback.body.cashback.used, true);
    assert.equal((await request(cashbackUrl, { ...supportAuth, method: 'POST' })).status, 409);

    assert.equal((await fetch(`${base}/plans`)).status, 404);
    assert.equal((await fetch(`${base}/atendimento/members`, { headers: adminAuth.headers })).status, 404);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await AppDataSource.destroy();
    fs.rmSync(dbPath, { force: true });
  }
});
