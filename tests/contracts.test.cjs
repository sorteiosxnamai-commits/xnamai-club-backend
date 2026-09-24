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
const bcrypt = require('bcryptjs');
const { UserRole } = require('../dist/entities/User');
const { createApp } = require('../dist/server');
const { authRouter } = require('../dist/routes/auth');
const { plansRouter } = require('../dist/routes/plans');
const { subscriptionsRouter } = require('../dist/routes/subscriptions');
const { customerRouter } = require('../dist/routes/customer');
const { atendimentoRouter } = require('../dist/routes/atendimento');
const { seedInitialData } = require('../dist/services/seed');

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
  await seedInitialData();
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

    const plan = await AppDataSource.getRepository(Plan).findOneByOrFail({ code: 'LAUNCH' });
    const priorityPlan = await AppDataSource.getRepository(Plan).findOneByOrFail({ code: 'PRIORITY' });
    const plans = await request('/api/plans');
    assert.equal(plans.status, 200);
    assert.equal(plans.body.length, 2);
    assert.equal(plans.body[0].monthlyPriceCents, 14997);
    assert.equal(plans.body[1].code, 'PRIORITY');
    assert.equal(plans.body[1].monthlyPriceCents, 29797);
    assert.match(plans.body[1].description, /prioridade nos pedidos/i);

    assert.equal((await request('/api/subscriptions/me')).status, 404);
    assert.equal((await request('/api/me/dashboard')).body.subscription, null);
    const checkout = await request('/api/subscriptions/checkout', { method: 'POST',
      body: JSON.stringify({ planId: plan.id, paymentMethodType: 'CREDIT_CARD' }) });
    assert.equal(checkout.status, 400); // Stripe absent: no checkout URL invented.

    const user = await AppDataSource.getRepository(User).findOneByOrFail({ email: profile.email });
    user.launchCashbackEligibleAt = new Date('2026-09-24T18:00:00.000Z');
    await AppDataSource.getRepository(User).save(user);
    await AppDataSource.getRepository(Subscription).save({ user, plan, status: SubscriptionStatus.ACTIVE,
      startedAt: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000) });
    assert.equal((await request('/api/subscriptions/me')).body.status, 'ACTIVE');
    assert.equal((await request('/api/me/dashboard')).body.subscription.status, 'ACTIVE');
    assert.equal((await request('/api/subscriptions/upgrade', { method: 'POST',
      body: JSON.stringify({ planId: priorityPlan.id }) })).status, 400); // Price Stripe ainda ausente no teste.
    // --- atendimento publico, sem login ---
    const users = AppDataSource.getRepository(User);
    const anonymous = { headers: { Authorization: '' } };

    // segundo membro (para o ADMIN) e um cadastro sem assinatura (aba "nao assinaram")
    const second = await users.save(users.create({ email: 'second@example.invalid', name: 'Segundo Membro',
      passwordHash: await bcrypt.hash('x', 4), role: UserRole.CUSTOMER, city: 'Campinas', state: 'SP',
      document: '11222333000181', phone: '(11) 98888-7777' }));
    await AppDataSource.getRepository(Subscription).save({ user: second, plan, status: SubscriptionStatus.ACTIVE,
      startedAt: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000) });
    await users.save(users.create({ email: 'unsigned@example.invalid', name: 'Sem Assinatura',
      passwordHash: await bcrypt.hash('x', 4), role: UserRole.CUSTOMER }));

    const memberUrl = '/api/atendimento/members';
    const cashbackOf = (id) => `${memberUrl}/${id}/cashback-use`;
    const usedAt = async (id) => (await users.findOneByOrFail({ id })).launchCashbackUsedAt;

    // Visitantes leem a mesa completa (membros, sem assinatura, dados de busca).
    const desk = await request(`${memberUrl}?refresh=1`, anonymous);
    assert.equal(desk.status, 200);
    const joined = desk.body.joined.map((row) => row.email).sort();
    assert.deepEqual(joined, [profile.email, 'second@example.invalid'].sort());
    assert.deepEqual(desk.body.unsigned.map((row) => row.email), ['unsigned@example.invalid']);
    const profileRow = desk.body.joined.find((row) => row.email === profile.email);
    const secondRow = desk.body.joined.find((row) => row.email === 'second@example.invalid');
    assert.equal(profileRow.subscription.plan.code, 'LAUNCH');
    assert.equal(profileRow.subscription.plan.name, 'Plano Basic de Lançamento');
    assert.equal(profileRow.cashback.eligible, true);
    assert.equal(secondRow.document, '11222333000181');
    assert.equal(secondRow.phone, '(11) 98888-7777');
    assert.equal(secondRow.cashback.eligible, false);
    assert.equal(secondRow.cashback.amountCents, 0);
    assert.equal((await request(memberUrl)).status, 200);

    // Visitantes tambem marcam o cashback, sem ator autenticado.
    const cashback = await request(cashbackOf(user.id), { ...anonymous, method: 'POST' });
    assert.equal(cashback.status, 200);
    assert.equal(cashback.body.cashback.used, true);
    assert.ok(await usedAt(user.id));
    assert.equal((await users.findOneByOrFail({ id: user.id })).launchCashbackUsedById, null);
    assert.equal((await request(cashbackOf(user.id), { ...anonymous, method: 'POST' })).status, 409);
    assert.equal((await request(cashbackOf(second.id), { ...anonymous, method: 'POST' })).status, 400);

    assert.equal((await fetch(`${base}/plans`)).status, 404);
    assert.equal((await fetch(`${base}/atendimento/members`)).status, 404);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await AppDataSource.destroy();
    fs.rmSync(dbPath, { force: true });
  }
});
