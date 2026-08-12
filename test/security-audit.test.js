const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createTestDB } = require('./helpers/test-db');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function request(server, path, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

async function fixture(t) {
  const db = await createTestDB();
  db.run(`
    CREATE TABLE pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker',
      skill TEXT DEFAULT '',
      community_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created TEXT NOT NULL
    );
    CREATE TABLE communities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      created TEXT NOT NULL
    );
    CREATE TABLE invite_codes (code TEXT PRIMARY KEY, community_id TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE community_permissions (community_id TEXT NOT NULL, staff_name TEXT NOT NULL);
    CREATE TABLE staff_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      name TEXT,
      employment_status TEXT DEFAULT 'active'
    );
    CREATE TABLE community_memberships (community_id TEXT, staff_profile_id INTEGER);
    CREATE TABLE shift_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, work_date TEXT);
    CREATE TABLE attendance_records (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, work_date TEXT);
    CREATE TABLE ticket_activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, actor_user_id INTEGER);
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    INSERT INTO users (id, phone, password, name, role, status) VALUES
      (1, '13800000001', 'x', '主管', '主管', 'active'),
      (2, '13800000002', 'x', '组长', 'lead', 'active'),
      (3, '13800000003', 'x', '师傅', 'worker', 'active');
    INSERT INTO invite_codes (code, community_id, created) VALUES ('ABC123', 'default', '2026-08-11T00:00:00.000Z');
    INSERT INTO communities (id, name, address, created) VALUES ('default', '默认小区', '', '2026-08-11T00:00:00.000Z');
    INSERT INTO staff_profiles (id, user_id, name) VALUES (3, 3, '师傅');
    INSERT INTO community_memberships (community_id, staff_profile_id) VALUES ('default', 3);
    INSERT INTO shift_assignments (staff_id, work_date) VALUES (3, '2026-08-11');
    INSERT INTO attendance_records (staff_id, work_date) VALUES (3, '2026-08-11');
    INSERT INTO ticket_activity_logs (ticket_id, actor_user_id) VALUES ('ticket-1', 3);
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

test('只有主管拥有最高人员管理权限，lead 不能越权', async (t) => {
  const { server } = await fixture(t);
  assert.equal((await request(server, '/api/users', { headers: authHeader({ id: 2, role: 'lead' }) })).response.status, 403);
  assert.equal((await request(server, '/api/users', { headers: authHeader({ id: 1, role: '主管' }) })).response.status, 200);
});

test('注册申请不能通过客户端 role 提升为主管', async (t) => {
  const { server, db } = await fixture(t);
  const result = await request(server, '/api/register', {
    method: 'POST',
    body: JSON.stringify({
      phone: '13800000004', password: 'pass1234', name: '申请人', role: '主管', inviteCode: 'ABC123',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(db.exec("SELECT role FROM pending_registrations WHERE phone = '13800000004'")[0].values[0][0], 'worker');
});

test('停用账号后旧 token 立即失效且人员关联排班/考勤被清理，历史操作日志保留', async (t) => {
  const { server, db } = await fixture(t);
  const result = await request(server, '/api/users/3', {
    method: 'DELETE',
    headers: authHeader({ id: 1, role: '主管' }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(db.exec("SELECT status FROM users WHERE id = 3")[0].values[0][0], 'disabled');
  assert.equal(db.exec('SELECT employment_status FROM staff_profiles WHERE user_id = 3')[0].values[0][0], 'inactive');
  assert.equal(db.exec('SELECT COUNT(*) FROM community_memberships WHERE staff_profile_id = 3')[0].values[0][0], 0);
  assert.equal(db.exec('SELECT COUNT(*) FROM shift_assignments WHERE staff_id = 3')[0].values[0][0], 0);
  assert.equal(db.exec('SELECT COUNT(*) FROM attendance_records WHERE staff_id = 3')[0].values[0][0], 0);
  assert.equal(db.exec('SELECT COUNT(*) FROM ticket_activity_logs WHERE actor_user_id = 3')[0].values[0][0], 1);
  const login = await request(server, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000003', password: 'pass1234' }),
  });
  assert.equal(login.response.status, 403);
  assert.equal((await request(server, '/api/users', { headers: authHeader({ id: 3, role: 'worker' }) })).response.status, 401);
});

test('禁用账号登录会被拒绝', async (t) => {
  const { server, db } = await fixture(t);
  const hash = await bcrypt.hash('pass1234', 10);
  db.run('UPDATE users SET password = ?, status = ? WHERE id = 3', [hash, 'disabled']);
  const login = await request(server, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000003', password: 'pass1234' }),
  });
  assert.equal(login.response.status, 403);
});

test('业务数据和系统设置接口不能匿名访问', async (t) => {
  const { server } = await fixture(t);
  for (const path of [
    '/api/tickets',
    '/api/communities',
    '/api/staff/status',
    '/api/report',
    '/api/settings/reminder',
    '/api/shift-templates',
  ]) {
    assert.equal((await request(server, path)).response.status, 401, `${path} 应要求登录`);
  }
});

test('附件下载不能绕过登录保护', async (t) => {
  const { server } = await fixture(t);
  const response = await fetch(`${server.url}/uploads/ticket-1/example.png`);
  assert.equal(response.status, 401);
});

test('普通人员只能读取所属小区且不能读取邀请码或代发其他工单通知', async (t) => {
  const { server, db } = await fixture(t);
  db.run("INSERT INTO communities (id, name, address, created) VALUES ('secret', '秘密小区', '', '2026-08-11T00:00:00Z')");
  db.run("INSERT INTO invite_codes (code, community_id, created) VALUES ('SECRET1', 'secret', '2026-08-11T00:00:00Z')");
  db.run("ALTER TABLE tickets ADD COLUMN community_id TEXT DEFAULT 'default'");
  db.run("ALTER TABLE tickets ADD COLUMN created TEXT DEFAULT ''");
  db.run("INSERT INTO tickets (id, worker, community_id, created) VALUES ('secret-ticket', '其他师傅', 'secret', '2026-08-11T00:00:00Z')");
  const headers = authHeader({ id: 3, role: 'worker', name: '师傅' });
  const communities = await request(server, '/api/communities', { headers });
  assert.equal(communities.response.status, 200);
  assert.deepEqual(communities.body.data.map((item) => item.id), ['default']);
  assert.equal((await request(server, '/api/communities/secret/invite-code', { headers })).response.status, 403);
  assert.equal((await request(server, '/api/notify', {
    method: 'POST', headers, body: JSON.stringify({ ticketId: 'secret-ticket', event: 'completed' }),
  })).response.status, 403);
});

test('密码重置必须登录，不能只凭手机号接管账号', async (t) => {
  const { server } = await fixture(t);
  const response = await request(server, '/api/reset-password', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000003', newPassword: 'new-pass-123' }),
  });
  assert.equal(response.response.status, 401);
});

test('普通人员读取工单时只看到所属小区或本人负责的工单', async (t) => {
  const { server, db } = await fixture(t);
  db.run(`
    ALTER TABLE tickets ADD COLUMN community_id TEXT DEFAULT 'default';
    ALTER TABLE tickets ADD COLUMN assignee_user_id INTEGER;
    ALTER TABLE tickets ADD COLUMN created TEXT DEFAULT '';
    INSERT INTO tickets (id, worker, community_id, assignee_user_id, created) VALUES
      ('own', '师傅', 'default', 3, '2026-08-11T00:00:00Z'),
      ('other', '其他师傅', 'secret', 99, '2026-08-11T00:00:00Z');
  `);
  const worker = await request(server, '/api/tickets', { headers: authHeader({ id: 3, role: 'worker' }) });
  assert.equal(worker.response.status, 200);
  assert.deepEqual(worker.body.data.map(ticket => ticket.id), ['own']);
  const supervisor = await request(server, '/api/tickets', { headers: authHeader({ id: 1, role: '主管' }) });
  assert.equal(supervisor.response.status, 200);
  assert.deepEqual(supervisor.body.data.map(ticket => ticket.id).sort(), ['other', 'own']);
});
