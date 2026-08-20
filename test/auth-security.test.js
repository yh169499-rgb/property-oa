const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('./helpers/test-db');
const { tenantServer } = require('./helpers/tenant-fixture');
const { authHeader } = require('./helpers/auth');
const { ensureWorkforceSchema } = require('../workforce-schema');

async function fixture(t) {
  const db = await createTestDB();
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', '主管'),
      (2, '13800000002', 'x', '师傅', 'worker')
  `);
  db.run(`
    CREATE TABLE pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'worker',
      skill TEXT DEFAULT '',
      community_id TEXT DEFAULT 'default',
      status TEXT DEFAULT 'pending',
      created TEXT NOT NULL
    )
  `);
  db.run(`
    INSERT INTO pending_registrations
      (id, phone, password, name, role, community_id, status, created)
    VALUES (1, '13800000003', 'x', '待审核师傅', 'worker', 'default', 'pending', '2026-08-01T00:00:00.000Z')
  `);
  ensureWorkforceSchema(db);
  const server = await tenantServer(db);
  t.after(() => server.close());
  return { server };
}

async function request(server, path, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

test('人员与注册审核管理接口必须由主管登录后访问', async (t) => {
  const { server } = await fixture(t);
  const paths = ['/api/users', '/api/pending-registrations'];
  for (const path of paths) {
    assert.equal((await request(server, path)).response.status, 401, `${path} 未登录应拒绝`);
    assert.equal(
      (await request(server, path, { headers: authHeader({ id: 2, role: 'worker' }) })).response.status,
      403,
      `${path} 普通人员应拒绝`
    );
  }

  const lead = { headers: authHeader({ id: 1, role: 'lead' }) };
  assert.equal((await request(server, '/api/users', lead)).response.status, 200);
  const pending = await request(server, '/api/pending-registrations', lead);
  assert.equal(pending.response.status, 200);
  assert.equal(pending.body.pending_count, 1);
  assert.equal(pending.body.data.length, 1);
  assert.equal(Object.hasOwn(pending.body.data[0], 'password'), false, '审核列表不应返回密码哈希');
});

test('注册审核通过和拒绝也必须由主管操作', async (t) => {
  const { server } = await fixture(t);
  for (const action of ['approve', 'reject']) {
    const path = `/api/pending-registrations/1/${action}`;
    assert.equal((await request(server, path, { method: 'POST' })).response.status, 401, `${action} 未登录应拒绝`);
    assert.equal(
      (await request(server, path, { method: 'POST', headers: authHeader({ id: 2, role: 'worker' }) })).response.status,
      403,
      `${action} 普通人员应拒绝`
    );
  }
});

test('users 表存在时，数据库中已删除账号的旧 token 必须返回 401', async (t) => {
  const { server } = await fixture(t);
  const response = await request(server, '/api/users', {
    headers: authHeader({ id: 999, role: '主管', name: '已删除主管' }),
  });
  assert.equal(response.response.status, 401);
  assert.equal(response.body.code, 'AUTH_REQUIRED');
});
