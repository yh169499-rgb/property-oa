const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');
const database = require('../db');
const {
  generateToken,
  verifyToken,
  requireAdmin,
  requirePlatformOwner,
  requireTenantUser,
} = require('../middleware/auth');
const { createFullTestDB, one } = require('./helpers/tenant-fixture');
const { startHttpServer } = require('./helpers/http-server');
const { disableAccount } = require('../services/account-lifecycle');

async function fixture(t) {
  const db = await createFullTestDB();
  t.after(() => db.close());
  db.run(`INSERT INTO tenants(id,name,status,owner_user_id,staff_limit,created_at,updated_at) VALUES
    ('tenant-a','甲企业','active',1,4,'now','now'),
    ('tenant-b','乙企业','active',4,4,'now','now'),
    ('tenant-disabled','停用企业','disabled',3,4,'now','now')`);
  db.run(`INSERT INTO users(id,phone,password,name,role,status,tenant_id,session_version) VALUES
    (1,'13800000001','x','甲主管','主管','active','tenant-a',2),
    (2,'13800000002','x','甲员工','worker','active','tenant-a',4),
    (3,'13800000003','x','停用企业员工','worker','active','tenant-disabled',1),
    (9,'13800000009','x','平台运维','platform_owner','active',NULL,3)`);
  const restore = database.setDBForTests(db);
  t.after(restore);
  return db;
}

function runMiddleware(middleware, token) {
  return new Promise((resolve) => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ req, status: this.statusCode, body }); },
    };
    middleware(req, res, () => resolve({ req, status: res.statusCode }));
  });
}

function authorize(middleware, user) {
  let next = false;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  middleware({ user }, res, () => { next = true; });
  return { next, status: res.statusCode, body: res.body };
}

async function request(server, path, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const rawBody = await response.text();
  let body = rawBody;
  try { body = JSON.parse(rawBody); } catch (_) {}
  return { response, body };
}

async function httpFixture(t) {
  const db = await createFullTestDB();
  const password = await bcrypt.hash('pass1234', 4);
  db.run(`INSERT INTO tenants(id,name,status,owner_user_id,staff_limit,created_at,updated_at) VALUES
    ('tenant-a','甲企业','active',1,4,'now','now'),
    ('tenant-disabled','停用企业','disabled',3,4,'now','now')`);
  db.run(`INSERT INTO users(id,phone,password,name,role,status,tenant_id,session_version) VALUES
    (1,'13800000001',?,'甲主管','主管','active','tenant-a',2),
    (2,'13800000002',?,'甲员工','worker','active','tenant-a',4),
    (3,'13800000003',?,'停用企业员工','worker','active','tenant-disabled',1),
    (4,'13800000004',?,'乙主管','主管','active','tenant-b',1),
    (9,'13800000009',?,'平台运维','platform_owner','active',NULL,3)`,
  [password, password, password, password, password]);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

test('JWT only carries id and session_version and database overwrites forged claims', async (t) => {
  await fixture(t);
  const token = generateToken({ id: 2, session_version: 4, role: '主管', tenant_id: 'tenant-b' });
  const claims = jwt.verify(token, config.JWT_SECRET);
  assert.deepEqual(Object.keys(claims).filter((key) => !['iat', 'exp'].includes(key)).sort(), ['id', 'session_version']);
  const result = await runMiddleware(verifyToken, token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.req.user, {
    id: 2, phone: '13800000002', name: '甲员工', role: 'worker', status: 'active',
    tenant_id: 'tenant-a', session_version: 4, tenant_status: 'active',
  });
});

test('missing users, stale sessions, disabled users and disabled tenants all reject with 401', async (t) => {
  const db = await fixture(t);
  const cases = [
    jwt.sign({ id: 999, session_version: 0 }, config.JWT_SECRET),
    jwt.sign({ id: 2, session_version: 3 }, config.JWT_SECRET),
    jwt.sign({ id: 3, session_version: 1 }, config.JWT_SECRET),
  ];
  db.run("UPDATE users SET status='disabled' WHERE id=1");
  cases.push(jwt.sign({ id: 1, session_version: 2 }, config.JWT_SECRET));
  for (const token of cases) assert.equal((await runMiddleware(verifyToken, token)).status, 401);
});

test('platform, tenant and strict supervisor middleware use database identity only', async (t) => {
  await fixture(t);
  const manager = { role: '主管', tenant_id: 'tenant-a' };
  assert.equal(authorize(requireAdmin, manager).next, true);
  for (const role of ['admin', 'lead', 'manager', 'supervisor', '经理']) {
    assert.equal(authorize(requireAdmin, { role, tenant_id: 'tenant-a' }).status, 403);
  }
  assert.equal(authorize(requireTenantUser, { role: 'worker', tenant_id: 'tenant-a' }).next, true);
  assert.equal(authorize(requireTenantUser, { role: 'platform_owner', tenant_id: null }).status, 403);
  assert.equal(authorize(requirePlatformOwner, { role: 'platform_owner', tenant_id: null }).next, true);
  assert.equal(authorize(requirePlatformOwner, manager).status, 403);
});

test('enterprise login signs database session only and persists last login metadata', async (t) => {
  const { db, server } = await httpFixture(t);
  const result = await request(server, '/api/login', {
    method: 'POST', body: JSON.stringify({ phone: '13800000002', password: 'pass1234' }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.user, {
    id: 2, phone: '13800000002', name: '甲员工', role: 'worker', tenant_id: 'tenant-a',
  });
  const claims = jwt.verify(result.body.token, config.JWT_SECRET);
  assert.deepEqual(Object.keys(claims).filter(key => !['iat', 'exp'].includes(key)).sort(), ['id', 'session_version']);
  assert.equal(claims.id, 2);
  assert.equal(claims.session_version, 4);
  assert.match(one(db, 'SELECT last_login_at FROM users WHERE id=2').last_login_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('failed login persistence rolls last_login_at back in memory and returns a stable error', async (t) => {
  const { db, server } = await httpFixture(t);
  const originalSaveDB = database.saveDB;
  database.saveDB = () => Promise.reject(new Error('SQLITE_IOERR /secret/path'));
  t.after(() => { database.saveDB = originalSaveDB; });
  const result = await request(server, '/api/login', {
    method: 'POST', body: JSON.stringify({ phone: '13800000002', password: 'pass1234' }),
  });
  assert.equal(result.response.status, 500);
  assert.deepEqual(result.body, { error: '服务器内部错误', code: 'INTERNAL_ERROR' });
  assert.equal(one(db, 'SELECT last_login_at FROM users WHERE id=2').last_login_at, null);
  assert.doesNotMatch(JSON.stringify(result.body), /SQL|secret|path/i);
});

test('platform owner cannot use enterprise login, reset password, or enterprise APIs while health stays public', async (t) => {
  const { server } = await httpFixture(t);
  const login = await request(server, '/api/login', {
    method: 'POST', body: JSON.stringify({ phone: '13800000009', password: 'pass1234' }),
  });
  assert.equal(login.response.status, 403);
  assert.equal(login.body.code, 'PLATFORM_LOGIN_REQUIRED');
  assert.equal((await request(server, '/api/login', {
    method: 'POST', body: JSON.stringify({ phone: '13800000009', password: 'wrong-password' }),
  })).response.status, 401);

  const platformToken = generateToken({ id: 9, session_version: 3 });
  const headers = { Authorization: `Bearer ${platformToken}` };
  assert.equal((await request(server, '/api/tickets', { headers })).response.status, 403);
  assert.equal((await request(server, '/api/reset-password', {
    method: 'POST', headers,
    body: JSON.stringify({ phone: '13800000009', newPassword: 'new-pass' }),
  })).response.status, 403);
  assert.equal((await request(server, '/api/platform/not-yet-implemented', { headers })).response.status, 404);
  assert.equal((await request(server, '/api/enterprise-applications')).response.status, 404);
  assert.equal((await request(server, '/api/health')).response.status, 200);
});

test('password reset increments the database session and immediately revokes the previous token', async (t) => {
  const { db, server } = await httpFixture(t);
  const oldToken = generateToken({ id: 2, session_version: 4 });
  const result = await request(server, '/api/reset-password', {
    method: 'POST',
    headers: { Authorization: `Bearer ${oldToken}` },
    body: JSON.stringify({ phone: '13800000002', newPassword: 'new-pass' }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(one(db, 'SELECT session_version FROM users WHERE id=2').session_version, 5);
  assert.equal((await request(server, '/api/tickets', {
    headers: { Authorization: `Bearer ${oldToken}` },
  })).response.status, 401);
});

test('a tenant supervisor cannot reset another tenant or platform account password', async (t) => {
  const { db, server } = await httpFixture(t);
  const headers = { Authorization: `Bearer ${generateToken({ id: 1, session_version: 2 })}` };
  for (const phone of ['13800000004', '13800000009']) {
    const before = one(db, 'SELECT password,session_version FROM users WHERE phone=?', [phone]);
    const result = await request(server, '/api/reset-password', {
      method: 'POST', headers, body: JSON.stringify({ phone, newPassword: 'taken-over' }),
    });
    assert.equal(result.response.status, 404);
    assert.deepEqual(one(db, 'SELECT password,session_version FROM users WHERE phone=?', [phone]), before);
  }
});

test('disabling an account permanently revokes its session even after the account is re-enabled', async (t) => {
  const db = await fixture(t);
  const oldToken = generateToken({ id: 2, session_version: 4 });
  const disabled = disableAccount(2);
  assert.equal(disabled.found, true);
  assert.deepEqual(one(db, 'SELECT status,session_version FROM users WHERE id=2'), {
    status: 'disabled', session_version: 5,
  });
  db.run("UPDATE users SET status='active' WHERE id=2");
  assert.equal((await runMiddleware(verifyToken, oldToken)).status, 401);
});

test('authentication database failures return a stable 500 without SQL details', async (t) => {
  const restore = database.setDBForTests({ prepare() { throw new Error('SQLITE_CORRUPT SELECT password FROM users'); } });
  t.after(restore);
  const result = await runMiddleware(verifyToken, jwt.sign({ id: 1, session_version: 0 }, config.JWT_SECRET));
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: '服务器内部错误', code: 'INTERNAL_ERROR' });
  assert.doesNotMatch(JSON.stringify(result.body), /SQL|password|users/i);
});
