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
process.env.GMAIL_SENDER = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.GOOGLE_REFRESH_TOKEN = '';

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
    const unconfiguredRecovery = await request('/api/auth/forgot-password', {
      method: 'POST', body: JSON.stringify({ email: 'nobody@example.invalid' }),
    });
    assert.equal(unconfiguredRecovery.status, 503);
    const profile = { name: 'Cliente Teste', email: 'contract@example.invalid', password: 'SenhaTeste123!',
      city: 'São Paulo', state: 'SP', document: '52998224725' };
    const registered = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(profile) });
    assert.equal(registered.status, 201);
    assert.ok(registered.body.token);
    assert.equal(registered.body.user.document, profile.document);
    token = registered.body.token;
    assert.equal((await request('/api/auth/me')).body.email, profile.email);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: profile.email, password: profile.password }) })).status, 200);

    const duplicateDocument = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        ...profile,
        email: 'outro-email@example.invalid',
        document: '529.982.247-25',
      }),
    });
    assert.equal(duplicateDocument.status, 409);
    assert.match(duplicateDocument.body.message, /CPF ou CNPJ já cadastrado/);
    assert.match(duplicateDocument.body.issues.fieldErrors.document[0], /já cadastrado/);

    const customerToken = token;
    const forbiddenReset = await request(`/api/auth/users/${registered.body.user.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'NovaSenhaForte123!' }),
    });
    assert.equal(forbiddenReset.status, 403);

    const supportLogin = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'atendimento@xnamai.local', password: 'Atende123!' }),
    });
    assert.equal(supportLogin.status, 200);
    token = supportLogin.body.token;
    const reset = await request(`/api/auth/users/${registered.body.user.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'NovaSenhaForte123!' }),
    });
    assert.equal(reset.status, 200);
    assert.match(reset.body.message, /sucesso/);
    const newPasswordLogin = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: profile.email, password: 'NovaSenhaForte123!' }),
    });
    assert.equal(newPasswordLogin.status, 200);
    token = customerToken;

    const plan = await AppDataSource.getRepository(Plan).findOneByOrFail({ code: 'LAUNCH' });
    const priorityPlan = await AppDataSource.getRepository(Plan).findOneByOrFail({ code: 'PRIORITY' });
    const plans = await request('/api/plans');
    assert.equal(plans.status, 200);
    assert.equal(plans.body.length, 2);
    assert.equal(plans.body[0].monthlyPriceCents, 14997);
    assert.equal(plans.body[1].code, 'PRIORITY');
    assert.equal(plans.body[1].monthlyPriceCents, 29797);
    assert.equal(plans.body[1].compareAtPriceCents, 59997);
    assert.match(plans.body[1].description, /Fast Pass.*6 horas.*prioridade na separação/i);

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
    assert.equal(profileRow.subscription.plan.name, 'Plano Basic');
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

test('customer recovery keeps account responses uniform and consumes tokens once', async () => {
  const { createHash } = require('node:crypto');
  const db = require('../dist/config/data-source').AppDataSource;
  await db.initialize();
  const { User, UserRole } = require('../dist/entities/User');
  const { createPasswordResetRouter } = require('../dist/routes/password-reset');
  const { signAccessToken } = require('../dist/middleware/auth');
  const sent = [];
  const app = express().use(express.json()).use('/api/auth', createPasswordResetRouter(async (to, link) => { sent.push({ to, link }); }), authRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${base}/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const repo = db.getRepository(User);
    const user = await repo.save(repo.create({ email: 'recovery@example.invalid', name: 'Recovery', passwordHash: await bcrypt.hash('oldpassword', 12), role: UserRole.CUSTOMER }));
    await repo.save(repo.create({ email: 'staff@example.invalid', name: 'Staff', passwordHash: await bcrypt.hash('staffpassword', 12), role: UserRole.SUPPORT }));
    const oldJwt = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    const missing = await post('forgot-password', { email: 'missing@example.invalid' });
    const exists = await post('forgot-password', { email: user.email });
    const staff = await post('forgot-password', { email: 'staff@example.invalid' });
    assert.equal(missing.status, 202);
    assert.deepEqual(exists, missing);
    assert.deepEqual(staff, missing);
    assert.equal(sent.length, 1);
    const first = new URL(sent[0].link).searchParams.get('token');
    assert.equal(first.length, 64);
    const stored = await repo.createQueryBuilder('user').addSelect('user.passwordResetTokenHash').where('user.id = :id', { id: user.id }).getOneOrFail();
    assert.equal(stored.passwordResetTokenHash, createHash('sha256').update(first).digest('hex'));
    assert.equal((await post('reset-password', { token: 'x'.repeat(64), password: 'newpassword' })).status, 400);
    await post('forgot-password', { email: user.email });
    const second = new URL(sent[1].link).searchParams.get('token');
    assert.equal((await post('reset-password', { token: first, password: 'newpassword' })).status, 400);
    assert.equal((await post('reset-password', { token: second, password: 'newpassword' })).status, 200);
    assert.equal((await post('reset-password', { token: second, password: 'anotherpassword' })).status, 400);
    assert.ok(await bcrypt.compare('newpassword', (await repo.findOneByOrFail({ id: user.id })).passwordHash));
    assert.equal((await post('login', { email: user.email, password: 'oldpassword' })).status, 401);
    assert.equal((await post('login', { email: user.email, password: 'newpassword' })).status, 200);
    assert.equal((await post('forgot-password', { email: user.email })).status, 202);
    const expired = await repo.createQueryBuilder('user').addSelect('user.passwordResetExpiresAt').where('user.id = :id', { id: user.id }).getOneOrFail();
    expired.passwordResetExpiresAt = new Date(Date.now() - 1000);
    await repo.save(expired);
    assert.equal((await post('reset-password', { token: new URL(sent[2].link).searchParams.get('token'), password: 'anotherpassword' })).status, 400);
    assert.equal((await post('forgot-password', { email: user.email })).status, 429);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await post('reset-password', { token: 'f'.repeat(64), password: 'anotherpassword' })).status, 400);
    }
    assert.equal((await post('reset-password', { token: 'f'.repeat(64), password: 'anotherpassword' })).status, 429);
    const authApp = express().get('/me', require('../dist/middleware/auth').requireAuth, (_req, res) => res.json({ ok: true }));
    const authServer = await new Promise(resolve => { const listener = authApp.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const response = await fetch(`http://127.0.0.1:${authServer.address().port}/me`, { headers: { authorization: `Bearer ${oldJwt}` } });
      assert.equal(response.status, 401);
    } finally { await new Promise(resolve => authServer.close(resolve)); }

    const failedMailUser = await repo.save(repo.create({ email: 'failed-mail@example.invalid', name: 'Failed Mail', passwordHash: await bcrypt.hash('oldpassword', 12), role: UserRole.CUSTOMER }));
    const failedMailApp = express().use(express.json()).use('/api/auth', createPasswordResetRouter(async () => { throw new Error('provider failure'); }));
    const failedMailServer = await new Promise(resolve => { const listener = failedMailApp.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const response = await fetch(`http://127.0.0.1:${failedMailServer.address().port}/api/auth/forgot-password`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: failedMailUser.email }),
      });
      assert.equal(response.status, 202);
      const row = await repo.createQueryBuilder('user').addSelect('user.passwordResetTokenHash').where('user.id = :id', { id: failedMailUser.id }).getOneOrFail();
      assert.equal(row.passwordResetTokenHash, null);
    } finally { await new Promise(resolve => failedMailServer.close(resolve)); }

    const { GmailDeliveryUncertainError } = require('../dist/services/recovery-mail');
    const uncertainUser = await repo.save(repo.create({ email: 'uncertain-mail@example.invalid', name: 'Uncertain Mail', passwordHash: await bcrypt.hash('oldpassword', 12), role: UserRole.CUSTOMER }));
    const uncertainApp = express().use(express.json()).use('/api/auth', createPasswordResetRouter(async () => { throw new GmailDeliveryUncertainError(); }));
    const uncertainServer = await new Promise(resolve => { const listener = uncertainApp.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const response = await fetch(`http://127.0.0.1:${uncertainServer.address().port}/api/auth/forgot-password`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: uncertainUser.email }),
      });
      assert.equal(response.status, 202);
      const row = await repo.createQueryBuilder('user').addSelect('user.passwordResetTokenHash').where('user.id = :id', { id: uncertainUser.id }).getOneOrFail();
      assert.ok(row.passwordResetTokenHash);
    } finally { await new Promise(resolve => uncertainServer.close(resolve)); }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.destroy();
    fs.rmSync(dbPath, { force: true });
  }
});
