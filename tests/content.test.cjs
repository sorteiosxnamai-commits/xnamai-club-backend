const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_TYPE = 'sqlite';
const fs = require('node:fs');
const path = require('node:path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', `content-${process.pid}.sqlite`);
process.env.STRIPE_SECRET_KEY = '';
process.env.TYPEORM_SYNCHRONIZE = 'true';
const { AppDataSource } = require('../dist/config/data-source');
const { createApp } = require('../dist/server');
const { signAccessToken } = require('../dist/middleware/auth');
const { User } = require('../dist/entities/User');

test('content is public to read, admin-only to publish, persistent and protected from stale writes', async () => {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(User);
  const admin = await repo.save(repo.create({ email: 'content-admin@example.invalid', name: 'Editor', passwordHash: 'unused', role: 'ADMIN' }));
  const support = await repo.save(repo.create({ email: 'content-support@example.invalid', name: 'Support', passwordHash: 'unused', role: 'SUPPORT' }));
  const token = (user) => signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, method = 'GET', body, user) => {
    const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await request('/content')).status, 200);
    const draft = { revision: 0, values: { title: 'Novo título <script>texto</script>' } };
    assert.equal((await request('/admin/content/home', 'PUT', draft)).status, 401);
    assert.equal((await request('/admin/content/home', 'PUT', draft, support)).status, 403);
    const published = await request('/admin/content/home', 'PUT', draft, admin);
    assert.equal(published.status, 200);
    assert.equal(published.body.revision, 1);
    assert.equal((await request('/content')).body.home.values.title, draft.values.title);
    assert.equal((await request('/admin/content/home', 'PUT', draft, admin)).status, 409);
    assert.equal((await request('/admin/content/unknown', 'PUT', draft, admin)).status, 400);
    assert.equal((await request('/admin/content/home', 'PUT', { revision: 1, values: { title: ' ' } }, admin)).status, 400);
    assert.equal((await request('/admin/content/home', 'PUT', { revision: 1, values: {}, surprise: true }, admin)).status, 400);
    const revisions = await request('/admin/content/home/history', 'GET', undefined, admin);
    assert.equal(revisions.body.length, 1);
    assert.equal(revisions.body[0].actorUserId, admin.id);
    await request('/admin/content/home', 'PUT', { revision: 1, values: {} }, admin);
    assert.deepEqual((await request('/content')).body.home.values, {});
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await AppDataSource.destroy(); fs.rmSync(process.env.DB_PATH, { force: true }); }
});
