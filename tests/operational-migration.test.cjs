const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { OperationalCorrections1793836800000 } = require('../dist/migrations/1793836800000-OperationalCorrections');
test('operational migration preserves legacy rows and can run twice', async () => {
  const db = new DataSource({ type: 'sqlite', database: ':memory:', migrations: [OperationalCorrections1793836800000] });
  await db.initialize();
  try {
    await db.query('CREATE TABLE subscriptions (id varchar PRIMARY KEY)');
    await db.query("INSERT INTO subscriptions (id) VALUES ('existing')");
    assert.equal((await db.runMigrations()).length, 1);
    assert.equal((await db.runMigrations()).length, 0);
    assert.deepEqual(await db.query('SELECT id, billingAmountCents FROM subscriptions'), [{ id: 'existing', billingAmountCents: null }]);
    const runner = db.createQueryRunner();
    assert.equal(await runner.hasTable('site_content'), true);
    assert.equal(await runner.hasTable('priority_reservations'), true);
    await runner.release();
  } finally { await db.destroy(); }
});
