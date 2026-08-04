const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('./helpers/test-db');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { migrateUsersToProfiles } = require('../services/workforce-migration');

async function fixture(t) {
  const db = await createTestDB();
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', 'lead'),
      (2, '13800000002', 'x', '组长', 'lead'),
      (3, '13800000003', 'x', '师傅', 'worker'),
      (4, '13800000004', 'x', '未分配人员', 'worker')
  `);
  ensureWorkforceSchema(db);
  migrateUsersToProfiles(db, '2026-07-30T00:00:00.000Z');
  db.run(`
    UPDATE staff_profiles SET manager_id = CASE user_id
      WHEN 2 THEN 1 WHEN 3 THEN 2 ELSE NULL END
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

async function request(server, path, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

test('GET /api/me 未登录返回 401，登录后返回本人档案', async (t) => {
  const { server } = await fixture(t);
  const denied = await request(server, '/api/me');
  assert.equal(denied.response.status, 401);

  const result = await request(server, '/api/me', {
    headers: authHeader({ id: 3, phone: '13800000003', name: '师傅', role: 'worker' }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.user_id, 3);
  assert.equal(result.body.data.name, '师傅');
});

test('本人 PATCH 只允许 phone 和 birth_month，并原子同步登录手机号', async (t) => {
  const { db, server } = await fixture(t);
  const headers = authHeader({ id: 3, phone: '13800000003', name: '师傅', role: 'worker' });
  const result = await request(server, '/api/me', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ phone: '13900000003', birth_month: '07' }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.phone, '13900000003');
  assert.equal(result.body.data.birth_month, '07');
  assert.equal(
    db.exec('SELECT phone FROM users WHERE id = 3')[0].values[0][0],
    '13900000003'
  );

  const conflict = await request(server, '/api/me', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ phone: '13800000002', birth_month: '08' }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, 'PHONE_CONFLICT');
  assert.deepEqual(
    db.exec('SELECT phone FROM users WHERE id = 3')[0].values[0],
    ['13900000003']
  );
  assert.deepEqual(
    db.exec('SELECT phone, birth_month FROM staff_profiles WHERE user_id = 3')[0].values[0],
    ['13900000003', '07']
  );

  const forbidden = await request(server, '/api/me', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ position: '主管' }),
  });
  assert.equal(forbidden.response.status, 400);
  assert.equal(forbidden.body.code, 'INVALID_PROFILE_FIELDS');
});

test('普通用户不能管理档案，主管可创建和修改批准字段', async (t) => {
  const { server } = await fixture(t);
  const worker = authHeader({ id: 3, role: 'worker' });
  assert.equal((await request(server, '/api/staff/profiles', { headers: worker })).response.status, 403);
  assert.equal((await request(server, '/api/staff/profiles/2', { headers: worker })).response.status, 403);
  assert.equal((await request(server, '/api/staff/profiles/2/team', { headers: worker })).response.status, 403);

  const lead = authHeader({ id: 1, role: 'lead' });
  const created = await request(server, '/api/staff/profiles', {
    method: 'POST',
    headers: lead,
    body: JSON.stringify({ name: '新员工', phone: '13800000005', position: '维修师傅', manager_id: 2 }),
  });
  assert.equal(created.response.status, 201);

  const changed = await request(server, `/api/staff/profiles/${created.body.data.id}`, {
    method: 'PATCH',
    headers: lead,
    body: JSON.stringify({
      position: '高级维修师傅',
      join_date: '2026-07-30',
      skill: '电梯',
      manager_id: 1,
    }),
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.data.position, '高级维修师傅');
  assert.equal(changed.body.data.join_date, '2026-07-30');
  assert.equal(changed.body.data.skill, '电梯');
  assert.equal(changed.body.data.manager_id, 1);
});

test('管理端 POST 和 PATCH 多步写入失败时完整回滚', async (t) => {
  const { db, server } = await fixture(t);
  const headers = authHeader({ id: 1, role: 'lead' });

  const failedCreate = await request(server, '/api/staff/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '不应保留', manager_id: 5 }),
  });
  assert.equal(failedCreate.response.status, 409);
  assert.equal(failedCreate.body.code, 'ORGANIZATION_CYCLE');
  assert.equal(
    db.exec("SELECT COUNT(*) FROM staff_profiles WHERE name = '不应保留'")[0].values[0][0],
    0
  );

  const failedPatch = await request(server, '/api/staff/profiles/3', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ manager_id: null, user_id: 2 }),
  });
  assert.equal(failedPatch.response.status, 500);
  assert.deepEqual(
    db.exec('SELECT user_id, manager_id FROM staff_profiles WHERE id = 3')[0].values[0],
    [3, 2]
  );
});

test('主管设置循环上级返回统一 409 错误', async (t) => {
  const { server } = await fixture(t);
  const result = await request(server, '/api/staff/profiles/1/manager', {
    method: 'PATCH',
    headers: authHeader({ id: 1, role: 'lead' }),
    body: JSON.stringify({ manager_id: 3 }),
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'ORGANIZATION_CYCLE');
  assert.deepEqual(result.body.details.path, [1, 2, 3, 1]);
});

test('组织树返回层级、未分配人员，team 返回全部下级', async (t) => {
  const { server } = await fixture(t);
  const headers = authHeader({ id: 1, role: 'lead' });
  const organization = await request(server, '/api/organization/tree', { headers });
  assert.equal(organization.response.status, 200);
  assert.equal(organization.body.data.tree[0].children[0].children[0].name, '师傅');
  assert.equal(organization.body.data.unassigned[0].name, '未分配人员');

  const team = await request(server, '/api/staff/profiles/1/team', { headers });
  assert.equal(team.response.status, 200);
  assert.deepEqual(team.body.data.map((profile) => profile.id), [2, 3]);
});
