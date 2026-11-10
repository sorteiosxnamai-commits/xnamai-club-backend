const { test } = require('node:test');
const assert = require('node:assert/strict');
const { indexAsaasCustomers, asaasDeskForMember, attachAsaasDesk } = require('../dist/services/asaas-desk');

const now = new Date('2026-11-10T15:00:00.000Z');

function snapshot(extra = {}) {
  return {
    customers: [{ id: 'cus_1', name: 'Chorão Presentes', email: 'paulovchorao.mtb@gmail.com', cpfCnpj: '43.083.808/0001-92' }],
    subscriptions: [{
      id: 'sub_1',
      customer: 'cus_1',
      value: 297.97,
      cycle: 'MONTHLY',
      status: 'ACTIVE',
      billingType: 'PIX',
      description: 'Plano Prioridade',
      dateCreated: '2026-11-02',
      nextDueDate: '2026-12-02',
      deleted: false,
    }],
    payments: [{
      id: 'pay_1',
      customer: 'cus_1',
      subscription: 'sub_1',
      value: 297.97,
      status: 'RECEIVED',
      billingType: 'PIX',
      paymentDate: '2026-11-02',
      dueDate: '2026-11-02',
    }],
    ...extra,
  };
}

test('a paid Asaas subscription matches the club member by email and shows an active plan', () => {
  const match = asaasDeskForMember(indexAsaasCustomers(snapshot()), {
    email: 'PauloVChorao.mtb@gmail.com',
    document: null,
  }, now);
  assert.equal(match.signed, true);
  assert.equal(match.active, true);
  assert.equal(match.status, 'ACTIVE');
  assert.equal(match.plan.name, 'Plano Prioridade');
  assert.equal(match.plan.monthlyPriceCents, 29797);
  assert.equal(match.paymentMethod.type, 'PIX_RECURRING');
  assert.equal(match.paymentMethod.provider, 'asaas');
  assert.match(match.validUntil, /^2026-12-02/);
});

test('the same payer matches by CNPJ when the e-mail differs', () => {
  const match = asaasDeskForMember(indexAsaasCustomers(snapshot()), {
    email: 'outro@example.com',
    document: '43083808000192',
  }, now);
  assert.equal(match.active, true);
  assert.equal(match.plan.name, 'Plano Prioridade');
});

test('an Asaas subscription without a received payment stays pending', () => {
  const data = snapshot();
  data.payments = [];
  const match = asaasDeskForMember(indexAsaasCustomers(data), { email: 'paulovchorao.mtb@gmail.com' }, now);
  assert.equal(match.signed, true);
  assert.equal(match.active, false);
  assert.equal(match.status, 'PENDING');
});

test('a paid month keeps access after the Asaas subscription is inactivated', () => {
  const data = snapshot();
  data.subscriptions[0].status = 'INACTIVE';
  const match = asaasDeskForMember(indexAsaasCustomers(data), { email: 'paulovchorao.mtb@gmail.com' }, now);
  assert.equal(match.active, true);
  assert.equal(match.status, 'ACTIVE');
});

test('stripe and asaas stay side by side when both exist', () => {
  const match = asaasDeskForMember(indexAsaasCustomers(snapshot()), { email: 'paulovchorao.mtb@gmail.com' }, now);
  const merged = attachAsaasDesk({
    boleto: false,
    subscription: { status: 'CANCELLED', active: false, validUntil: '2026-11-04T17:50:55.000Z', plan: { name: 'Plano Prioridade', monthlyPriceCents: 29797 } },
    paymentMethod: { type: 'CREDIT_CARD', cardBrand: 'visa', cardLastFour: '7812' },
  }, match);
  assert.equal(merged.subscription.status, 'CANCELLED');
  assert.equal(merged.subscription.plan.name, 'Plano Prioridade');
  assert.equal(merged.paymentMethod.cardLastFour, '7812');
  assert.equal(merged.asaas.active, true);
  assert.equal(merged.asaas.plan.name, 'Plano Prioridade');
  assert.equal(merged.asaas.paymentMethod.provider, 'asaas');
});

test('a customer without the same e-mail still matches a unique company name', () => {
  const data = snapshot({
    customers: [{ id: 'cus_1', name: 'Paulo', email: 'outro@asaas.com', company: 'Chorão Presentes', cpfCnpj: '00000000000000' }],
  });
  const match = asaasDeskForMember(indexAsaasCustomers(data), {
    email: 'paulovchorao.mtb@gmail.com',
    document: '43083808000192',
    companyName: 'Chorao Presentes',
  }, now);
  assert.equal(match.active, true);
});
