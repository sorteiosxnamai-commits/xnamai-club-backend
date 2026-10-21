const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = { brevoApiKey: 'key-test', brevoSenderEmail: 'contato@clubxnamai.com.br' };

test('Brevo sends recovery to the requested recipient and returns its message id', async () => {
  const { sendRecoveryEmail } = require('../dist/services/recovery-mail');
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 201, json: async () => ({ messageId: '<message-test@brevo.com>' }) };
  };

  const messageId = await sendRecoveryEmail('cliente@example.com', 'https://clubxnamai.com.br/redefinir-senha?token=abc', fetcher, config);
  assert.equal(messageId, '<message-test@brevo.com>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['api-key'], 'key-test');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.sender, { email: 'contato@clubxnamai.com.br', name: 'xNaMai Club' });
  assert.deepEqual(body.to, [{ email: 'cliente@example.com' }]);
  assert.match(body.subject, /Redefinição de senha/);
  assert.match(body.textContent, /redefinir-senha\?token=abc/);
  assert.match(body.htmlContent, /redefinir-senha\?token=abc/);
  assert.doesNotMatch(calls[0].options.body, /key-test/);
});

test('Brevo API rejection does not expose credentials or response body', async () => {
  const { sendRecoveryEmail } = require('../dist/services/recovery-mail');
  const fetcher = async () => ({ ok: false, status: 401, text: async () => 'key-test' });
  await assert.rejects(sendRecoveryEmail('cliente@example.com', 'https://clubxnamai.com.br/reset', fetcher, config), /Brevo API request failed \(401\)/);
});

test('lost Brevo response is classified as uncertain delivery', async () => {
  const { sendRecoveryEmail, MailDeliveryUncertainError } = require('../dist/services/recovery-mail');
  assert.equal(typeof MailDeliveryUncertainError, 'function');
  const fetcher = async () => { throw new Error('connection reset'); };
  await assert.rejects(sendRecoveryEmail('cliente@example.com', 'https://clubxnamai.com.br/reset', fetcher, config), MailDeliveryUncertainError);
});
