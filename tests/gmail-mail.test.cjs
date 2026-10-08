const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Gmail sender exchanges refresh token and sends one multipart MIME message', async () => {
  const { sendRecoveryEmail } = require('../dist/services/recovery-mail');
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { ok: true, json: async () => ({ access_token: 'access-test' }) };
    return { ok: true, status: 200 };
  };
  await sendRecoveryEmail('cliente@example.invalid', 'https://club.example/redefinir-senha?token=abc', fetcher, {
    gmailSender: 'sorteiosxnamai@gmail.com', googleClientId: 'client-test', googleClientSecret: 'secret-test', googleRefreshToken: 'refresh-test',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(new URLSearchParams(calls[0].options.body).get('grant_type'), 'refresh_token');
  assert.equal(new URLSearchParams(calls[0].options.body).get('refresh_token'), 'refresh-test');
  assert.equal(calls[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer access-test');
  const mime = Buffer.from(JSON.parse(calls[1].options.body).raw, 'base64url').toString('utf8');
  assert.match(mime, /From: xNaMai Club <sorteiosxnamai@gmail.com>/);
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(mime, /Redefinir minha senha/);
  assert.match(mime, /30 minutos/);
  assert.doesNotMatch(mime, /secret-test|refresh-test|access-test/);
});

test('Gmail send failure rejects without exposing provider response or secrets', async () => {
  const { sendRecoveryEmail } = require('../dist/services/recovery-mail');
  const config = { gmailSender: 'sorteiosxnamai@gmail.com', googleClientId: 'client-test', googleClientSecret: 'secret-test', googleRefreshToken: 'refresh-test' };
  const fetcher = async (_url, options) => options.headers.Authorization
    ? { ok: false, status: 403, text: async () => 'secret-test' }
    : { ok: true, json: async () => ({ access_token: 'access-test' }) };
  await assert.rejects(sendRecoveryEmail('cliente@example.invalid', 'https://club.example/reset', fetcher, config), /Gmail API request failed/);
});

test('lost Gmail send response is classified as uncertain delivery', async () => {
  const { sendRecoveryEmail, GmailDeliveryUncertainError } = require('../dist/services/recovery-mail');
  const config = { gmailSender: 'sorteiosxnamai@gmail.com', googleClientId: 'client-test', googleClientSecret: 'secret-test', googleRefreshToken: 'refresh-test' };
  const fetcher = async (_url, options) => {
    if (options.headers.Authorization) throw new Error('connection reset');
    return { ok: true, json: async () => ({ access_token: 'access-test' }) };
  };
  await assert.rejects(sendRecoveryEmail('cliente@example.invalid', 'https://club.example/reset', fetcher, config), GmailDeliveryUncertainError);
});
