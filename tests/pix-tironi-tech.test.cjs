const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clubOffer, pixTironiTechAsaas } = require('../dist/config/club-pricing');

const previous = process.env.PIX_TIRONI_TECH_ASAAS;

test('pix tironi tech asaas stays off by default and keeps the XNaMai PIX links', () => {
  delete process.env.PIX_TIRONI_TECH_ASAAS;
  assert.equal(pixTironiTechAsaas(), false);
  assert.equal(clubOffer('LAUNCH').pixUrl, 'https://www.asaas.com/000/c/o1ec2qy62xy2osok');
  assert.equal(clubOffer('PRIORITY').pixUrl, 'https://www.asaas.com/000/c/dh2huehi75bvitg5');
  assert.equal(clubOffer('LAUNCH').boletoUrl, 'https://www.asaas.com/000/c/o1ec2qy62xy2osok');
  assert.equal(clubOffer('PRIORITY').cardUrl, 'https://www.asaas.com/000/c/h0k06a6rr4d00swi');
});

test('pix tironi tech asaas stays on the XNaMai links even if the env flag is true', () => {
  process.env.PIX_TIRONI_TECH_ASAAS = 'true';
  assert.equal(pixTironiTechAsaas(), false);
  assert.equal(clubOffer('LAUNCH').pixUrl, 'https://www.asaas.com/000/c/o1ec2qy62xy2osok');
  assert.equal(clubOffer('PRIORITY').pixUrl, 'https://www.asaas.com/000/c/dh2huehi75bvitg5');
});

test('pix tironi tech asaas false keeps the previous PIX links', () => {
  process.env.PIX_TIRONI_TECH_ASAAS = 'false';
  assert.equal(pixTironiTechAsaas(), false);
  assert.equal(clubOffer('LAUNCH').pixUrl, 'https://www.asaas.com/000/c/o1ec2qy62xy2osok');
  assert.equal(clubOffer('PRIORITY').pixUrl, 'https://www.asaas.com/000/c/dh2huehi75bvitg5');
  if (previous == null) delete process.env.PIX_TIRONI_TECH_ASAAS;
  else process.env.PIX_TIRONI_TECH_ASAAS = previous;
});
