const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('./helpers/test-db');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function fixture(t) {
  const db = await createTestDB();
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', 'lead'),
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
  const server = await startHttpServer(db);
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
  assert.equal((await request(server, '/api/pending-registrations', lead)).response.status, 200);
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
