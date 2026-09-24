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
const { AuditLog } = require('../dist/entities/AuditLog');
const bcrypt = require('bcryptjs');
const { UserRole } = require('../dist/entities/User');
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
    // --- mesa interna de atendimento: ADMIN e SUPPORT, com login real ---
    const users = AppDataSource.getRepository(User);
    const staff = async (role, email) => {
      const password = 'EquipeTeste123!';
      const saved = await users.save(users.create({ email, name: `Equipe ${role}`, companyName: 'XNaMai',
        passwordHash: await bcrypt.hash(password, 4), role }));
      const login = await request('/api/auth/login', { method: 'POST', headers: { Authorization: '' },
        body: JSON.stringify({ email, password }) });
      assert.equal(login.status, 200);
      assert.equal(login.body.user.role, role);
      return { id: saved.id, auth: { headers: { Authorization: `Bearer ${login.body.token}` } } };
    };
    const support = await staff(UserRole.SUPPORT, 'support@example.invalid');
    const admin = await staff(UserRole.ADMIN, 'admin@example.invalid');
    const customerAuth = { headers: { Authorization: `Bearer ${token}` } };
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

    // anonimo -> 401, cliente -> 403; nenhum dos dois altera o cashback
    assert.equal((await request(memberUrl, anonymous)).status, 401);
    assert.equal((await request(cashbackOf(user.id), { ...anonymous, method: 'POST' })).status, 401);
    assert.equal((await request(memberUrl, customerAuth)).status, 403);
    assert.equal((await request(cashbackOf(user.id), { ...customerAuth, method: 'POST' })).status, 403);
    assert.equal(await usedAt(user.id), null);

    // SUPPORT e ADMIN leem a mesa completa (membros, sem assinatura, dados de busca)
    const desk = await request(`${memberUrl}?refresh=1`, support.auth);
    assert.equal(desk.status, 200);
    const joined = desk.body.joined.map((row) => row.email).sort();
    assert.deepEqual(joined, [profile.email, 'second@example.invalid'].sort());
    assert.deepEqual(desk.body.unsigned.map((row) => row.email), ['unsigned@example.invalid']);
    const secondRow = desk.body.joined.find((row) => row.email === 'second@example.invalid');
    assert.equal(secondRow.document, '11222333000181');
    assert.equal(secondRow.phone, '(11) 98888-7777');
    assert.equal(secondRow.cashback.eligible, true);
    assert.equal((await request(memberUrl, admin.auth)).status, 200);

    // SUPPORT e ADMIN marcam o cashback; o autor fica registrado
    const bySupport = await request(cashbackOf(user.id), { ...support.auth, method: 'POST' });
    assert.equal(bySupport.status, 200);
    assert.equal(bySupport.body.cashback.used, true);
    assert.equal((await users.findOneByOrFail({ id: user.id })).launchCashbackUsedById, support.id);
    const byAdmin = await request(cashbackOf(second.id), { ...admin.auth, method: 'POST' });
    assert.equal(byAdmin.status, 200);
    assert.equal((await users.findOneByOrFail({ id: second.id })).launchCashbackUsedById, admin.id);
    const actors = (await AppDataSource.getRepository(AuditLog).findBy({ action: 'LAUNCH_CASHBACK_USED' }))
      .map((row) => [row.entityId, row.actorUserId]).sort();
    assert.deepEqual(actors, [[second.id, admin.id], [user.id, support.id]].sort());
    assert.equal((await request(cashbackOf(user.id), { ...support.auth, method: 'POST' })).status, 409);

    const adminAuth = admin.auth;
    assert.equal((await fetch(`${base}/plans`)).status, 404);
    assert.equal((await fetch(`${base}/atendimento/members`, { headers: adminAuth.headers })).status, 404);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await AppDataSource.destroy();
    fs.rmSync(dbPath, { force: true });
  }
});
