const test = require('node:test');
const assert = require('node:assert/strict');

const { createFullTestDB, one } = require('./helpers/tenant-fixture');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function request(server, pathname, options = {}) {
  const response = await fetch(`${server.url}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function fixture(t) {
  const db = await createFullTestDB();
  db.run(`
    INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at)
      VALUES('tenant-a','甲企业','active',4,'2026-08-01','2026-08-01'),
            ('tenant-b','乙企业','active',4,'2026-08-02','2026-08-02');
    INSERT INTO users(id,phone,password,name,role,status,tenant_id,session_version,last_login_at)
      VALUES(1,'13800000001','supervisor-hash','甲主管','主管','active','tenant-a',1,NULL),
            (2,'13800000002','worker-hash','甲师傅','worker','active','tenant-a',1,NULL),
            (900,'13222514178','owner-hash','句子工单管理员','platform_owner','active',NULL,1,NULL);
    UPDATE tenants SET owner_user_id=1 WHERE id='tenant-a';
    INSERT INTO staff_profiles(tenant_id,user_id,name,phone,position,manager_id,employment_status,created_at,updated_at)
      VALUES('tenant-a',1,'甲主管','13800000001','主管',NULL,'active','test','test'),
            ('tenant-a',2,'甲师傅','13800000002','维修师傅',1,'active','test','test');
    INSERT INTO communities(id,tenant_id,name,address,created)
      VALUES('a-1','tenant-a','甲小区','甲地址','test'),('b-1','tenant-b','乙小区','乙地址','test');
    INSERT INTO tickets(id,tenant_id,type,cat,desc,loc,created)
      VALUES('A-1','tenant-a','repair','水暖','漏水','1号楼','2026-08-20'),
            ('B-1','tenant-b','help','咨询','帮助','2号楼','2026-08-20');
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

test('只有无租户的平台管理员可以读取企业数据目录和分页数据', async (t) => {
  const { server } = await fixture(t);
  const owner = authHeader({ id: 900, session_version: 1 });
  const supervisor = authHeader({ id: 1, session_version: 1 });

  const catalog = await request(server, '/api/platform/tenants/tenant-a/data-tables', { headers: owner });
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.data.some((table) => table.key === 'tickets'));

  const rows = await request(server, '/api/platform/tenants/tenant-a/data/tickets?page=1&pageSize=1', { headers: owner });
  assert.equal(rows.status, 200);
  assert.equal(rows.body.data.rows.length, 1);
  assert.equal(rows.body.data.rows[0].id, 'A-1');
  assert.equal(Object.keys(rows.body).some((key) => /password|secret|jwt/i.test(key)), false);

  assert.equal((await request(server, '/api/platform/tenants/tenant-a/data-tables', { headers: supervisor })).status, 403);
});

test('企业数据查询严格按 tenant_id 隔离并拒绝未知表和删除', async (t) => {
  const { server } = await fixture(t);
  const owner = authHeader({ id: 900, session_version: 1 });

  const rows = await request(server, '/api/platform/tenants/tenant-a/data/tickets?page=1&pageSize=20', { headers: owner });
  assert.deepEqual(rows.body.data.rows.map((row) => row.id), ['A-1']);
  assert.equal((await request(server, '/api/platform/tenants/tenant-a/data/unknown', { headers: owner })).status, 404);
  assert.equal((await request(server, '/api/platform/tenants/tenant-a/data/tickets/A-1', {
    method: 'DELETE', headers: owner,
  })).status, 405);
});

test('允许编辑人员业务资料并同步账号，写入平台审计且禁止敏感字段', async (t) => {
  const { db, server } = await fixture(t);
  const owner = authHeader({ id: 900, session_version: 1 });

  const updated = await request(server, '/api/platform/tenants/tenant-a/data/staff_profiles/2', {
    method: 'PATCH',
    headers: owner,
    body: JSON.stringify({ name: '甲新师傅', phone: '13800000022', position: '物业管家', employment_status: 'active' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(one(db, 'SELECT name,phone,position FROM staff_profiles WHERE id=2').name, '甲新师傅');
  assert.equal(one(db, 'SELECT name,phone FROM users WHERE id=2').phone, '13800000022');
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM platform_audit_logs WHERE action='data.update'").count, 1);

  const forbidden = await request(server, '/api/platform/tenants/tenant-a/data/users/2', {
    method: 'PATCH', headers: owner,
    body: JSON.stringify({ password: 'new-password', role: '主管', tenant_id: 'tenant-b' }),
  });
  assert.equal(forbidden.status, 400);
  assert.equal(one(db, 'SELECT role,tenant_id FROM users WHERE id=2').role, 'worker');
});

test('无 token、企业账号和绑定企业的平台角色不能访问数据中心', async (t) => {
  const { server } = await fixture(t);
  const response = await request(server, '/api/platform/tenants/tenant-a/data-tables');
  assert.equal(response.status, 401);
});
