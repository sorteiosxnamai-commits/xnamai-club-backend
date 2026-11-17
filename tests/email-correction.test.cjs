const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
process.env.DB_TYPE = 'sqlite';
process.env.DB_PATH = path.join(__dirname, '..', 'data', `email-correction-${process.pid}.sqlite`);
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.STRIPE_SECRET_KEY = '';
process.env.REDIS_URL = '';
const { AppDataSource: db } = require('../dist/config/data-source');
const { User } = require('../dist/entities/User');
const { Plan } = require('../dist/entities/Plan');
const { Subscription } = require('../dist/entities/Subscription');
const { seedInitialData, correctTatianaEmail } = require('../dist/services/seed');

before(async () => {
  await db.initialize();
  await seedInitialData();
});
after(async () => {
  await db.destroy();
  fs.rmSync(process.env.DB_PATH, { force: true });
});

test('the hotmail typo is corrected only after the empty probe account releases it', async () => {
  const users = db.getRepository(User);
  const plan = await db.getRepository(Plan).findOneByOrFail({ code: 'LAUNCH' });
  const tatiana = await users.save(users.create({
    email: 'tatypresentes1981@horamail.com', passwordHash: 'unused', role: 'CUSTOMER', name: 'Tatiana Belinato lima', companyName: 'Tuty presentes',
  }));
  const probe = await users.save(users.create({
    email: 'tatypresentes1981@hotmail.com', passwordHash: 'unused', role: 'CUSTOMER', name: 'Probe User', companyName: 'Probe Loja',
  }));
  const subscription = await db.getRepository(Subscription).save({ user: probe, plan, status: 'ACTIVE' });

  await correctTatianaEmail();
  assert.equal((await users.findOneByOrFail({ id: tatiana.id })).email, 'tatypresentes1981@horamail.com');
  assert.equal((await users.findOneByOrFail({ id: probe.id })).email, 'tatypresentes1981@hotmail.com');

  await db.getRepository(Subscription).delete({ id: subscription.id });
  await correctTatianaEmail();
  assert.equal((await users.findOneByOrFail({ id: tatiana.id })).email, 'tatypresentes1981@hotmail.com');
  assert.equal((await users.findOneByOrFail({ id: probe.id })).email, `retired-${probe.id}@invalid.local`);

  await correctTatianaEmail();
  assert.equal((await users.findOneByOrFail({ id: tatiana.id })).email, 'tatypresentes1981@hotmail.com');
});
