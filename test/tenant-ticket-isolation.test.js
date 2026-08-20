const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../config');
const { createFullTestDB } = require('./helpers/tenant-fixture');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

const MANAGER_A = { id: 101 };
const WORKER_A = { id: 102 };
const MANAGER_B = { id: 201 };
const WORKER_B = { id: 202 };

function one(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result[0]) return null;
  return Object.fromEntries(result[0].columns.map((column, index) => (
    [column, result[0].values[0][index]]
  )));
}

async function fixture(t) {
  const db = await createFullTestDB();
  const now = '2026-08-20T00:00:00.000Z';
  db.run(`INSERT INTO tenants
    (id, name, status, staff_limit, created_at, updated_at) VALUES
    ('tenant-a', '甲企业', 'active', 4, ?, ?),
    ('tenant-b', '乙企业', 'active', 4, ?, ?)`, [now, now, now, now]);
  db.run(`INSERT INTO users
    (id, phone, password, name, role, status, tenant_id, session_version) VALUES
    (101, '13900000101', 'x', '甲主管', '主管', 'active', 'tenant-a', 0),
    (102, '13900000102', 'x', '甲师傅', 'worker', 'active', 'tenant-a', 0),
    (201, '13900000201', 'x', '乙主管', '主管', 'active', 'tenant-b', 0),
    (202, '13900000202', 'x', '乙师傅', 'worker', 'active', 'tenant-b', 0)`);
  db.run(`UPDATE tenants SET owner_user_id = CASE id
    WHEN 'tenant-a' THEN 101 WHEN 'tenant-b' THEN 201 END`);
  db.run(`INSERT INTO staff_profiles
    (id, tenant_id, user_id, name, position, employment_status, created_at, updated_at) VALUES
    (101, 'tenant-a', 101, '甲主管', '主管', 'active', ?, ?),
    (102, 'tenant-a', 102, '甲师傅', '维修师傅', 'active', ?, ?),
    (201, 'tenant-b', 201, '乙主管', '主管', 'active', ?, ?),
    (202, 'tenant-b', 202, '乙师傅', '维修师傅', 'active', ?, ?)`,
  [now, now, now, now, now, now, now, now]);
  db.run('UPDATE staff_profiles SET manager_id = 101 WHERE id = 102');
  db.run('UPDATE staff_profiles SET manager_id = 201 WHERE id = 202');
  db.run(`INSERT INTO communities (id, tenant_id, name, created) VALUES
    ('community-a', 'tenant-a', '甲小区', ?),
    ('community-b', 'tenant-b', '乙小区', ?)`, [now, now]);
  db.run(`INSERT INTO community_memberships
    (tenant_id, community_id, staff_profile_id, created_at) VALUES
    ('tenant-a', 'community-a', 101, ?),
    ('tenant-a', 'community-a', 102, ?),
    ('tenant-b', 'community-b', 201, ?),
    ('tenant-b', 'community-b', 202, ?)`, [now, now, now, now]);
  db.run(`INSERT INTO performance_rule_versions
    (id, tenant_id, version_no, name, completion_weight, on_time_weight,
      quality_weight, excellent_threshold, good_threshold, qualified_threshold,
      minimum_sample_size, effective_at, created_at, is_active) VALUES
    (1001, 'tenant-a', 1, '甲规则', 40, 30, 30, 90, 75, 60, 1, ?, ?, 1),
    (2001, 'tenant-b', 2, '乙规则', 40, 30, 30, 90, 75, 60, 1, ?, ?, 1)`,
  [now, now, now, now]);
  db.run(`INSERT INTO tickets
    (id, tenant_id, type, cat, status, worker, assignee_user_id,
      assignee_staff_profile_id, community_id, created) VALUES
    ('A-1', 'tenant-a', 'repair', '水暖', 'wait', '甲师傅', 102, 102, 'community-a', ?),
    ('B-1', 'tenant-b', 'complaint', '噪音', 'wait', '乙师傅', 202, 202, 'community-b', ?)`,
  [now, now]);

  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-oa-tenant-ticket-'));
  fs.mkdirSync(path.join(uploadDir, 'B-1'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'B-1', 'secret.png'), 'tenant-b-secret');
  fs.writeFileSync(path.join(uploadDir, 'B-1.json'), JSON.stringify([
    { filename: 'secret.png', url: '/uploads/B-1/secret.png' },
  ]));
  const originalUploadDir = config.UPLOAD_DIR;
  config.UPLOAD_DIR = uploadDir;
  const server = await startHttpServer(db);
  t.after(async () => {
    await server.close();
    config.UPLOAD_DIR = originalUploadDir;
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });
  return { db, server };
}

async function api(server, pathname, user, options = {}) {
  const response = await fetch(`${server.url}${pathname}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...authHeader(user),
      ...(options.headers || {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

test('主管和普通员工列表、详情只读取当前企业工单', async (t) => {
  const { server } = await fixture(t);

  const managerList = await api(server, '/api/tickets', MANAGER_A);
  assert.equal(managerList.status, 200);
  assert.deepEqual(managerList.body.data.map((ticket) => ticket.id), ['A-1']);

  const workerList = await api(server, '/api/tickets', WORKER_A);
  assert.deepEqual(workerList.body.data.map((ticket) => ticket.id), ['A-1']);
  assert.equal((await api(server, '/api/tickets/B-1', MANAGER_A)).status, 404);
  assert.equal((await api(server, '/api/tickets/B-1', WORKER_A)).status, 404);
});

test('跨企业工单修改和删除明确返回 403 且不改变数据', async (t) => {
  const { db, server } = await fixture(t);

  const patched = await api(server, '/api/tickets/B-1', MANAGER_A, {
    method: 'PATCH', body: JSON.stringify({ status: 'doing' }),
  });
  assert.equal(patched.status, 403);
  assert.equal(patched.body.code, 'TICKET_SCOPE_FORBIDDEN');

  const removed = await api(server, '/api/tickets/B-1', MANAGER_A, { method: 'DELETE' });
  assert.equal(removed.status, 403);
  assert.equal(removed.body.code, 'TICKET_SCOPE_FORBIDDEN');
  assert.deepEqual(one(db, "SELECT status FROM tickets WHERE id = 'B-1'"), { status: 'wait' });
});

test('创建和修改拒绝客户端 tenant_id 或 tenantId', async (t) => {
  const { server } = await fixture(t);

  const queried = await api(server, '/api/tickets?tenant_id=tenant-b', MANAGER_A);
  assert.equal(queried.status, 400);
  assert.equal(queried.body.code, 'CLIENT_TENANT_FORBIDDEN');

  for (const injected of [{ tenant_id: 'tenant-b' }, { tenantId: 'tenant-b' }]) {
    const created = await api(server, '/api/tickets', MANAGER_A, {
      method: 'POST',
      body: JSON.stringify({ id: `INJECT-${Object.keys(injected)[0]}`, type: 'repair', community_id: 'community-a', ...injected }),
    });
    assert.equal(created.status, 400);
    assert.equal(created.body.code, 'CLIENT_TENANT_FORBIDDEN');

    const patched = await api(server, '/api/tickets/A-1', MANAGER_A, {
      method: 'PATCH', body: JSON.stringify(injected),
    });
    assert.equal(patched.status, 400);
    assert.equal(patched.body.code, 'CLIENT_TENANT_FORBIDDEN');
  }
});

test('创建、流转、小区和派单身份均强制绑定当前企业', async (t) => {
  const { db, server } = await fixture(t);

  const foreignCommunity = await api(server, '/api/tickets', MANAGER_A, {
    method: 'POST',
    body: JSON.stringify({ id: 'FOREIGN-COMMUNITY', type: 'repair', community_id: 'community-b' }),
  });
  assert.equal(foreignCommunity.status, 400);
  assert.equal(foreignCommunity.body.code, 'COMMUNITY_NOT_FOUND');

  const foreignAssignee = await api(server, '/api/tickets/A-1', MANAGER_A, {
    method: 'PATCH', body: JSON.stringify({ worker: '乙师傅', status: 'doing' }),
  });
  assert.equal(foreignAssignee.status, 409);
  assert.equal(foreignAssignee.body.code, 'ASSIGNEE_NOT_ELIGIBLE');

  const foreignRule = await api(server, '/api/tickets/A-1', MANAGER_A, {
    method: 'PATCH', body: JSON.stringify({ performance_rule_version_id: 2001 }),
  });
  assert.equal(foreignRule.status, 400);
  assert.equal(foreignRule.body.code, 'PERFORMANCE_RULE_NOT_FOUND');

  const created = await api(server, '/api/tickets', MANAGER_A, {
    method: 'POST',
    body: JSON.stringify({ id: 'A-NEW', type: 'help', community_id: 'community-a', worker: '甲师傅', status: 'doing' }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(one(db, "SELECT tenant_id, community_id, assignee_user_id, performance_rule_version_id FROM tickets WHERE id = 'A-NEW'"), {
    tenant_id: 'tenant-a', community_id: 'community-a', assignee_user_id: 102,
    performance_rule_version_id: 1001,
  });

  const updated = await api(server, '/api/tickets/A-NEW', WORKER_A, {
    method: 'PATCH', body: JSON.stringify({ status: 'pending' }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(one(db, "SELECT tenant_id, actor_user_id FROM ticket_activity_logs WHERE ticket_id = 'A-NEW'"), {
    tenant_id: 'tenant-a', actor_user_id: 102,
  });
});

test('跨企业附件列表和原始下载返回 404，上传返回 403', async (t) => {
  const { server } = await fixture(t);

  assert.equal((await api(server, '/api/tickets/B-1/photos', MANAGER_A)).status, 404);

  const form = new FormData();
  form.append('photos', new Blob(['x'], { type: 'image/png' }), 'x.png');
  const uploaded = await fetch(`${server.url}/api/tickets/B-1/photos`, {
    method: 'POST', headers: authHeader(MANAGER_A), body: form,
  });
  assert.equal(uploaded.status, 403);
  assert.equal((await uploaded.json()).code, 'TICKET_SCOPE_FORBIDDEN');

  const raw = await fetch(`${server.url}/uploads/B-1/secret.png`, {
    headers: authHeader(MANAGER_A),
  });
  assert.equal(raw.status, 404);
});
