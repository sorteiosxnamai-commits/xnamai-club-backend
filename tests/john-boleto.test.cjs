const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isJohnAsaasCustomer,
  openChargesToCancel,
  paidNovemberBoleto,
  subscriptionsToStop,
  boletoAccessWindow,
} = require('../dist/services/release-john-boleto');

test('only John Magalhães customers match', () => {
  assert.equal(isJohnAsaasCustomer({ name: 'JOHN MAGALHAES ALCANTARA', cpfCnpj: '53665631000196' }), true);
  assert.equal(isJohnAsaasCustomer({ name: 'JOHN MAGALHÃES DE ALCÂNTARA', email: 'placeshinobi@gmail.com' }), true);
  assert.equal(isJohnAsaasCustomer({ name: 'Breno Ferreira de Oliveira Magalhaes', cpfCnpj: '27263236000177' }), false);
});

test('december open charges are cancelled and the paid november boleto is kept', () => {
  const payments = [
    { id: 'card-nov', value: 149.97, status: 'CHARGEBACK_REQUESTED', dueDate: '2026-11-06', deleted: false },
    { id: 'boleto-paid', value: 199.99, status: 'RECEIVED', dueDate: '2026-11-10', paymentDate: '2026-11-10', deleted: false },
    { id: 'card-dec', value: 149.97, status: 'PENDING', dueDate: '2026-12-06', deleted: false },
    { id: 'boleto-dec', value: 199.99, status: 'PENDING', dueDate: '2026-12-10', deleted: false },
  ];
  assert.deepEqual(openChargesToCancel(payments).map((payment) => payment.id), ['card-dec', 'boleto-dec']);
  assert.equal(paidNovemberBoleto(payments).id, 'boleto-paid');
  assert.equal(boletoAccessWindow(payments[1]).periodEnd.toISOString().slice(0, 10), '2026-12-10');
});

test('active card and boleto subscriptions stop, paid history does not', () => {
  const rows = subscriptionsToStop([
    { id: 'card', value: 149.97, status: 'ACTIVE', deleted: false },
    { id: 'boleto', value: 199.99, status: 'ACTIVE', deleted: false },
    { id: 'old', value: 149.97, status: 'INACTIVE', deleted: false },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['card', 'boleto']);
});
