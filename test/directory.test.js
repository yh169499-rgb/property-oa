const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, phone TEXT, password TEXT, name TEXT, role TEXT
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, created TEXT NOT NULL, community_id TEXT DEFAULT 'default'
    );
    CREATE TABLE communities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '', created TEXT NOT NULL
    );
    CREATE TABLE community_permissions (
      community_id TEXT NOT NULL, staff_name TEXT NOT NULL,
      PRIMARY KEY (community_id, staff_name)
    );
  `);
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', 'lead'),
      (2, '13800000002', 'x', '张三', 'worker'),
      (3, '13800000003', 'x', '张三', 'worker'),
      (4, '13800000004', 'x', '李四', 'worker');
    INSERT INTO staff_profiles (id, user_id, name, phone, position, employment_status) VALUES
      (1, 1, '主管', '13800000001', '主管', 'active'),
      (2, 2, '张三', '13800000002', '维修师傅', 'active'),
      (3, 3, '张三', '13800000003', '维修师傅', 'active'),
      (4, 4, '李四', '13800000004', '管家', 'inactive');
    INSERT INTO communities (id, name, created) VALUES
      ('c1', '一号小区', '2026-01-01T00:00:00Z'),
      ('c2', '二号小区', '2026-01-01T00:00:00Z');
    INSERT INTO community_memberships (community_id, staff_profile_id) VALUES
      ('c1', 2), ('c1', 4), ('c2', 3);
  `);
  return db;
}

test('同小区通讯录只返回 active 人员必要字段', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/staff/directory?community_id=c1`, {
    headers: authHeader({ id: 2, role: 'worker' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((item) => item.id), [2]);
  assert.deepEqual(Object.keys(body.data[0]).sort(), ['id', 'name', 'phone', 'position', 'skill']);
  assert.equal(body.data[0].phone, '13800000002');
});

test('跨小区通讯录和未登录访问被拒绝', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const forbidden = await fetch(`${server.url}/api/staff/directory?community_id=c2`, {
    headers: authHeader({ id: 2, role: 'worker' }),
  });
  assert.equal(forbidden.status, 403);
  const anonymous = await fetch(`${server.url}/api/staff/directory?community_id=c1`);
  assert.equal(anonymous.status, 401);
});

test('姓名相同的人员不会通过旧权限表串到通讯录', async (t) => {
  const db = await fixture();
  db.run("INSERT INTO community_permissions (community_id, staff_name) VALUES ('c1', '张三')");
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/staff/directory?community_id=c1`, {
    headers: authHeader({ id: 2, role: 'worker' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((item) => item.id), [2]);
  assert.equal(body.data.some((item) => item.phone === '13800000003'), false);
});
