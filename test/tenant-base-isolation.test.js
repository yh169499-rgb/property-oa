const test = require('node:test');
const assert = require('node:assert/strict');

const { authHeader } = require('./helpers/auth');
const { createFullTestDB } = require('./helpers/tenant-fixture');
const { startHttpServer } = require('./helpers/http-server');

function seedTwoTenants(db) {
  db.run(`
    INSERT INTO tenants
      (id, name, status, owner_user_id, staff_limit, created_at, updated_at) VALUES
      ('tenant-a', '企业 A', 'active', NULL, 4, '2026-08-20', '2026-08-20'),
      ('tenant-b', '企业 B', 'active', NULL, 4, '2026-08-20', '2026-08-20');

    INSERT INTO users
      (id, phone, password, name, role, status, tenant_id, session_version) VALUES
      (1, '13800000001', 'x', 'A 主管', '主管', 'active', 'tenant-a', 0),
      (2, '13800000002', 'x', 'tenant-a-secret-师傅', 'worker', 'active', 'tenant-a', 0),
      (101, '13900000001', 'x', 'B 主管', '主管', 'active', 'tenant-b', 0),
      (102, '13900000002', 'x', 'tenant-b-secret-师傅', 'worker', 'active', 'tenant-b', 0);

    UPDATE tenants SET owner_user_id = 1 WHERE id = 'tenant-a';
    UPDATE tenants SET owner_user_id = 101 WHERE id = 'tenant-b';

    INSERT INTO staff_profiles
      (id, tenant_id, user_id, name, phone, position, manager_id, employment_status) VALUES
      (1, 'tenant-a', 1, 'A 主管', '13800000001', '主管', NULL, 'active'),
      (2, 'tenant-a', 2, 'tenant-a-secret-师傅', '13800000002', '维修师傅', 1, 'active'),
      (101, 'tenant-b', 101, 'B 主管', '13900000001', '主管', NULL, 'active'),
      (102, 'tenant-b', 102, 'tenant-b-secret-师傅', '13900000002', '维修师傅', 101, 'active');

    INSERT INTO communities (id, tenant_id, name, address, created) VALUES
      ('c-a', 'tenant-a', 'tenant-a-secret-小区', 'A 地址', '2026-08-20'),
      ('c-b', 'tenant-b', 'tenant-b-secret-小区', 'B 地址', '2026-08-20');

    INSERT INTO community_permissions (tenant_id, community_id, staff_name) VALUES
      ('tenant-a', 'c-a', 'tenant-a-secret-师傅'),
      ('tenant-b', 'c-b', 'tenant-b-secret-师傅');

    INSERT INTO community_memberships
      (tenant_id, community_id, staff_profile_id, created_at) VALUES
      ('tenant-a', 'c-a', 1, '2026-08-20'),
      ('tenant-a', 'c-a', 2, '2026-08-20'),
      ('tenant-b', 'c-b', 101, '2026-08-20'),
      ('tenant-b', 'c-b', 102, '2026-08-20');

    INSERT INTO staff_status (tenant_id, name, status, updated) VALUES
      ('tenant-a', 'tenant-a-secret-师傅', 'on', '2026-08-20'),
      ('tenant-b', 'tenant-b-secret-师傅', 'busy', '2026-08-20');
  `);
}

async function fixture(t) {
  const db = await createFullTestDB();
  seedTwoTenants(db);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

async function api(server, pathname, user = { id: 1 }, options = {}) {
  const response = await fetch(`${server.url}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(user),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

for (const [endpoint, ownMarker] of [
  ['/api/communities', 'tenant-a-secret-小区'],
  ['/api/staff/profiles', 'tenant-a-secret-师傅'],
  ['/api/organization/tree', 'tenant-a-secret-师傅'],
  ['/api/staff/directory?community_id=c-a', 'tenant-a-secret-师傅'],
  ['/api/staff/status', 'tenant-a-secret-师傅'],
]) {
  test(`${endpoint} 只返回当前企业基础资料`, async (t) => {
    const { server } = await fixture(t);
    const result = await api(server, endpoint);
    assert.equal(result.response.status, 200);
    const serialized = JSON.stringify(result.body);
    assert.match(serialized, new RegExp(ownMarker));
    assert.doesNotMatch(serialized, /tenant-b-secret/);
  });
}

test('跨企业详情和通讯录按不存在处理', async (t) => {
  const { server } = await fixture(t);
  const profile = await api(server, '/api/staff/profiles/102');
  assert.equal(profile.response.status, 404);
  assert.equal(profile.body.code, 'PROFILE_NOT_FOUND');

  const directory = await api(server, '/api/staff/directory?community_id=c-b');
  assert.equal(directory.response.status, 404);
  assert.equal(directory.body.code, 'COMMUNITY_NOT_FOUND');
});

test('主管不能通过路径 ID 修改其他企业档案或小区', async (t) => {
  const { db, server } = await fixture(t);
  const profile = await api(server, '/api/staff/profiles/102', { id: 1 }, {
    method: 'PATCH',
    body: JSON.stringify({ name: '越权修改' }),
  });
  assert.equal(profile.response.status, 403);
  assert.equal(profile.body.code, 'CROSS_TENANT_WRITE_FORBIDDEN');

  const community = await api(server, '/api/communities/c-b', { id: 1 }, {
    method: 'PATCH',
    body: JSON.stringify({ name: '越权小区' }),
  });
  assert.equal(community.response.status, 403);
  assert.equal(community.body.code, 'CROSS_TENANT_WRITE_FORBIDDEN');

  const removed = await api(server, '/api/communities/c-b', { id: 1 }, {
    method: 'DELETE',
  });
  assert.equal(removed.response.status, 403);
  assert.equal(removed.body.code, 'CROSS_TENANT_WRITE_FORBIDDEN');

  const invited = await api(server, '/api/communities/c-b/invite-code', { id: 1 }, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(invited.response.status, 403);
  assert.equal(invited.body.code, 'CROSS_TENANT_WRITE_FORBIDDEN');
  assert.equal(db.exec("SELECT name FROM staff_profiles WHERE id=102")[0].values[0][0], 'tenant-b-secret-师傅');
  assert.equal(db.exec("SELECT name FROM communities WHERE id='c-b'")[0].values[0][0], 'tenant-b-secret-小区');
});

test('上级绑定不能引用其他企业人员', async (t) => {
  const { db, server } = await fixture(t);
  const result = await api(server, '/api/staff/profiles/2/manager', { id: 1 }, {
    method: 'PATCH',
    body: JSON.stringify({ manager_id: 101 }),
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'CROSS_TENANT_WRITE_FORBIDDEN');
  assert.equal(db.exec('SELECT manager_id FROM staff_profiles WHERE id=2')[0].values[0][0], 1);

  const create = await api(server, '/api/staff/profiles', { id: 1 }, {
    method: 'POST',
    body: JSON.stringify({
      name: '越权新员工', position: '维修师傅', manager_id: 101,
    }),
  });
  assert.equal(create.response.status, 403);
  assert.equal(create.body.code, 'CROSS_TENANT_WRITE_FORBIDDEN');
  assert.equal(
    db.exec("SELECT COUNT(*) FROM staff_profiles WHERE name='越权新员工'")[0].values[0][0],
    0
  );
});

test('小区授权人员不能引用其他企业人员', async (t) => {
  const { db, server } = await fixture(t);
  const result = await api(server, '/api/communities', { id: 1 }, {
    method: 'POST',
    body: JSON.stringify({
      name: '越权授权小区',
      allowedStaff: ['tenant-b-secret-师傅'],
    }),
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'CROSS_TENANT_WRITE_FORBIDDEN');
  assert.equal(
    db.exec("SELECT COUNT(*) FROM communities WHERE name='越权授权小区'")[0].values[0][0],
    0
  );
});

test('客户端不能在基础资料写入中指定租户', async (t) => {
  const { server } = await fixture(t);
  for (const [path, body] of [
    ['/api/communities', { name: '伪造小区', tenant_id: 'tenant-b' }],
    ['/api/staff/profiles', {
      name: '伪造人员', position: '维修师傅', manager_id: 1, tenantId: 'tenant-b',
    }],
  ]) {
    const result = await api(server, path, { id: 1 }, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, 'CLIENT_TENANT_FORBIDDEN');
  }
});

test('在岗状态写入仅修改当前企业同名记录', async (t) => {
  const { db, server } = await fixture(t);
  db.run(`INSERT INTO staff_profiles
    (id, tenant_id, name, position, manager_id, employment_status) VALUES
    (3, 'tenant-a', '同名员工', '维修师傅', 1, 'active'),
    (103, 'tenant-b', '同名员工', '维修师傅', 101, 'active')`);
  db.run(`INSERT INTO staff_status (tenant_id, name, status, updated) VALUES
    ('tenant-a', '同名员工', 'on', 'old'), ('tenant-b', '同名员工', 'busy', 'old')`);
  const result = await api(server, '/api/staff/status', { id: 1 }, {
    method: 'POST',
    body: JSON.stringify({ name: '同名员工', status: 'off' }),
  });
  assert.equal(result.response.status, 200);
  const statuses = db.exec("SELECT tenant_id,status FROM staff_status WHERE name='同名员工' ORDER BY tenant_id")[0].values;
  assert.deepEqual(statuses, [['tenant-a', 'off'], ['tenant-b', 'busy']]);
});

test('tenant context 拒绝 SQL 标识符注入', async () => {
  const { assertSafeIdentifier } = require('../services/tenant-context');
  assert.equal(assertSafeIdentifier('staff_profiles'), 'staff_profiles');
  assert.throws(
    () => assertSafeIdentifier('staff_profiles; DROP TABLE users'),
    (error) => error.code === 'UNSAFE_SQL_IDENTIFIER'
  );
});
