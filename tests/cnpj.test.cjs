const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.DB_TYPE = 'sqlite';
process.env.DB_PATH = path.join(__dirname, '..', 'data', `cnpj-${process.pid}.sqlite`);
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.STRIPE_SECRET_KEY = '';
process.env.REDIS_URL = '';
const { AppDataSource: db } = require('../dist/config/data-source');
const { createApp } = require('../dist/server');
const { User } = require('../dist/entities/User');
const { Plan } = require('../dist/entities/Plan');
const { Subscription } = require('../dist/entities/Subscription');
const { signAccessToken } = require('../dist/middleware/auth');

test('CNPJ-only registration and legacy regularization preserve paid access and enforce unique businesses', async () => {
  await db.initialize();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, method = 'GET', body, token) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const profile = { name: 'Lojista Teste', companyName: 'Loja Teste', city: 'São Paulo', state: 'SP', email: 'cnpj@test.invalid', password: 'SenhaTeste123!', document: '04.252.011/0001-10' };
  try {
    const cpf = await request('/auth/register', 'POST', { ...profile, document: '52998224725' });
    assert.equal(cpf.status, 400); assert.ok(cpf.body.issues.fieldErrors.document);
    assert.equal((await request('/auth/register', 'POST', { ...profile, document: '04252011000111' })).status, 400);
    assert.equal((await request('/auth/register', 'POST', { ...profile, companyName: ' ' })).status, 400);
    const created = await request('/auth/register', 'POST', profile);
    assert.equal(created.status, 201); assert.equal(created.body.user.document, '04252011000110');
    assert.equal((await request('/auth/register', 'POST', { ...profile, email: 'duplicate@test.invalid' })).status, 409);
    const alpha = await request('/auth/register', 'POST', { ...profile, email: 'alpha@test.invalid', document: '00.000.000/e08g-12' });
    assert.equal(alpha.status, 201); assert.equal(alpha.body.user.document, '00000000E08G12');
    const legacy = await db.getRepository(User).save({ name: 'Cadastro antigo', companyName: 'Empresa antiga', document: '52998224725', role: 'CUSTOMER', email: 'legacy@test.invalid', passwordHash: 'unused' });
    const token = signAccessToken({ sub: legacy.id, role: legacy.role, email: legacy.email });
    const plan = await db.getRepository(Plan).save({ code: 'LAUNCH', name: 'Plano Basic', active: true, monthlyPriceCents: 14997 });
    const sub = await db.getRepository(Subscription).save({ user: legacy, plan, status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86400000) });
    assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 200);
    assert.equal((await request('/me/dashboard', 'GET', undefined, token)).body.access.active, true);
    for (const route of ['/subscriptions/payment-link', '/subscriptions/checkout', '/subscriptions/upgrade']) {
      const denied = await request(route, 'POST', { code: 'LAUNCH', method: 'PIX', planId: plan.id }, token);
      assert.equal(denied.status, 403); assert.equal(denied.body.code, 'BUSINESS_REGISTRATION_REQUIRED');
    }
    assert.equal((await request('/auth/business', 'PATCH', { companyName: 'Loja', document: profile.document }, token)).status, 409);
    const fixed = await request('/auth/business', 'PATCH', { companyName: 'Loja regularizada', document: '11.222.333/0001-81' }, token);
    assert.equal(fixed.status, 200); assert.equal(fixed.body.user.document, '11222333000181');
    assert.equal((await db.getRepository(Subscription).findOneByOrFail({ id: sub.id })).status, 'ACTIVE');
    assert.equal((await request('/auth/business', 'PATCH', { companyName: 'Outra', document: '00000000E08G12' }, token)).status, 409);
    const oldSub = await db.getRepository(Subscription).findOneByOrFail({ id: sub.id });
    oldSub.status = 'CANCELLED'; oldSub.currentPeriodEnd = new Date(Date.now() - 86400000); await db.getRepository(Subscription).save(oldSub);
    const link = await request('/subscriptions/payment-link', 'POST', { code: 'LAUNCH', method: 'PIX' }, token);
    assert.equal(link.status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.destroy(); fs.rmSync(process.env.DB_PATH, { force: true }); }
});
