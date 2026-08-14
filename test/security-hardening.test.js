const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('./helpers/test-db');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');
const config = require('../config');
const fs = require('node:fs');
const path = require('node:path');

async function request(server, path, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

test('生产环境拒绝缺失或弱 JWT_SECRET', () => {
  assert.throws(
    () => config.validateSecurityConfig({ NODE_ENV: 'production', JWT_SECRET: 'local-development-only' }),
    /JWT_SECRET/
  );
  assert.throws(
    () => config.validateSecurityConfig({ RENDER: 'true', JWT_SECRET: 'short-secret' }),
    /JWT_SECRET/
  );
  assert.doesNotThrow(() => config.validateSecurityConfig({ NODE_ENV: 'test', JWT_SECRET: '' }));
});

test('旧版未加权限的服务默认禁止启动', () => {
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(legacy, /ALLOW_LEGACY_SERVER/);
  assert.match(legacy, /旧版服务已禁用/);
});

test('员工只能读取自己的排班，主管才可读取全员排班', async (t) => {
  const db = await createTestDB();
  db.run(`
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    CREATE TABLE staff_profiles (
      id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE, name TEXT, position TEXT,
      manager_id INTEGER, employment_status TEXT DEFAULT 'active'
    );
    CREATE TABLE shift_templates (
      id INTEGER PRIMARY KEY, name TEXT, start_time TEXT, end_time TEXT,
      color TEXT DEFAULT '', grace_minutes INTEGER DEFAULT 5, created_by INTEGER
    );
    CREATE TABLE shift_assignments (
      id INTEGER PRIMARY KEY, staff_id INTEGER, work_date TEXT, assignment_type TEXT,
      template_id INTEGER, start_at TEXT, end_at TEXT, leave_type TEXT, note TEXT,
      created_by INTEGER, updated_at TEXT
    );
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', '主管'),
      (2, '13800000002', 'x', '师傅甲', 'worker'),
      (3, '13800000003', 'x', '师傅乙', 'worker');
    INSERT INTO staff_profiles (id, user_id, name, position, manager_id) VALUES
      (1, 1, '主管', '主管', NULL),
      (2, 2, '师傅甲', '维修师傅', 1),
      (3, 3, '师傅乙', '维修师傅', 1);
    INSERT INTO shift_assignments (id, staff_id, work_date, assignment_type, note) VALUES
      (11, 2, '2026-08-14', 'leave', '甲的请假原因'),
      (12, 3, '2026-08-14', 'leave', '乙的请假原因');
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());

  const worker = await request(server, '/api/shifts', {
    headers: authHeader({ id: 2, role: 'worker', name: '师傅甲' }),
  });
  assert.equal(worker.response.status, 200);
  assert.deepEqual(worker.body.data.map((row) => row.id), [11]);
  assert.equal(worker.body.data[0].note, '甲的请假原因');

  const supervisor = await request(server, '/api/shifts', {
    headers: authHeader({ id: 1, role: '主管', name: '主管' }),
  });
  assert.equal(supervisor.response.status, 200);
  assert.deepEqual(supervisor.body.data.map((row) => row.id), [11, 12]);
});

test('密码写入接口拒绝过长或过短的新密码，避免 bcrypt 资源耗尽和弱密码', async (t) => {
  const db = await createTestDB();
  db.run(`
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    CREATE TABLE pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, password TEXT, name TEXT,
      role TEXT, skill TEXT, community_id TEXT, status TEXT, created TEXT
    );
    CREATE TABLE invite_codes (code TEXT PRIMARY KEY, community_id TEXT, created TEXT);
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', '主管');
    INSERT INTO invite_codes (code, community_id, created) VALUES
      ('ABC123', 'default', '2026-08-14');
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());

  const tooShort = await request(server, '/api/register', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000002', password: '1234567', name: '申请人', inviteCode: 'ABC123' }),
  });
  assert.equal(tooShort.response.status, 400);

  const tooLong = await request(server, '/api/register', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000003', password: 'x'.repeat(129), name: '申请人', inviteCode: 'ABC123' }),
  });
  assert.equal(tooLong.response.status, 400);
});

test('响应关闭 Express 指纹并设置基础安全响应头', async (t) => {
  const db = await createTestDB();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});
