const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

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
  const ownerHash = await bcrypt.hash('OwnerSecure!123', 4);
  const managerHash = await bcrypt.hash('ManagerPass!123', 4);
  db.run(`
    INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at)
      VALUES('tenant-a','甲企业','active',4,'2026-08-01','2026-08-01')`);
  db.run(`INSERT INTO users(id,phone,password,name,role,status,tenant_id,session_version)
      VALUES(1,'13800000001',?,'甲主管','主管','active','tenant-a',1),
            (900,'13222514178',?,'句子工单管理员','platform_owner','active',NULL,1)`,
  [managerHash, ownerHash]);
  db.run(`
    UPDATE tenants SET owner_user_id=1 WHERE id='tenant-a';
    INSERT INTO staff_profiles(tenant_id,user_id,name,phone,position,employment_status)
      VALUES('tenant-a',1,'甲主管','13800000001','主管','active');
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

test('公开企业申请可提交但不会登录或返回密码字段', async (t) => {
  const { db, server } = await fixture(t);
  const result = await request(server, '/api/enterprise-applications', {
    method: 'POST',
    body: JSON.stringify({
      enterpriseName: '新物业', supervisorName: '新主管',
      phone: '13900000001', password: 'SecurePass!123',
    }),
  });
  assert.equal(result.status, 201);
  assert.deepEqual(Object.keys(result.body.data).sort(), ['id', 'status']);
  assert.equal(result.body.data.status, 'pending');
  assert.equal(JSON.stringify(result.body).toLowerCase().includes('password'), false);
  assert.notEqual(one(db, 'SELECT password_hash FROM enterprise_applications WHERE id=?', [result.body.data.id]).password_hash, 'SecurePass!123');
});

test('平台使用独立登录，企业账号不能登录平台', async (t) => {
  const { db, server } = await fixture(t);
  const denied = await request(server, '/api/platform/login', {
    method: 'POST', body: JSON.stringify({ phone: '13800000001', password: 'ManagerPass!123' }),
  });
  assert.equal(denied.status, 401);
  const login = await request(server, '/api/platform/login', {
    method: 'POST', body: JSON.stringify({ phone: '13222514178', password: 'OwnerSecure!123' }),
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.data.token);
  assert.equal(login.body.data.user.role, 'platform_owner');
  assert.match(one(db, 'SELECT last_login_at FROM users WHERE id=900').last_login_at, /^\d{4}-/);
});

test('平台端点只接受数据库中的平台运维身份', async (t) => {
  const { server } = await fixture(t);
  const manager = authHeader({ id: 1, session_version: 1 });
  const owner = authHeader({ id: 900, session_version: 1 });
  assert.equal((await request(server, '/api/platform/overview', { headers: manager })).status, 403);
  const overview = await request(server, '/api/platform/overview', { headers: owner });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.data.tenant_count, 1);
  const tenants = await request(server, '/api/platform/tenants', { headers: owner });
  assert.equal(tenants.status, 200);
  assert.equal(tenants.body.data.length, 1);
});

test('平台可审核申请、调整上限、停用恢复和重置主管密码', async (t) => {
  const { db, server } = await fixture(t);
  const owner = authHeader({ id: 900, session_version: 1 });
  const submitted = await request(server, '/api/enterprise-applications', {
    method: 'POST',
    body: JSON.stringify({
      enterpriseName: '乙物业', supervisorName: '乙主管',
      phone: '13900000002', password: 'SecurePass!456',
    }),
  });
  const approved = await request(server, `/api/platform/applications/${submitted.body.data.id}/approve`, {
    method: 'POST', headers: owner, body: JSON.stringify({ staffLimit: 9 }),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.staffLimit, 9);

  const updated = await request(server, '/api/platform/tenants/tenant-a', {
    method: 'PATCH', headers: owner,
    body: JSON.stringify({ name: '甲物业集团', staffLimit: 8 }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.staff_limit, 8);
  const nameOnly = await request(server, '/api/platform/tenants/tenant-a', {
    method: 'PATCH', headers: owner,
    body: JSON.stringify({ name: '甲物业服务' }),
  });
  assert.equal(nameOnly.status, 200);
  assert.equal(nameOnly.body.data.name, '甲物业服务');
  assert.equal(nameOnly.body.data.staff_limit, 8);
  assert.equal((await request(server, '/api/platform/tenants/tenant-a/disable', {
    method: 'POST', headers: owner,
  })).status, 200);
  assert.equal((await request(server, '/api/platform/tenants/tenant-a/restore', {
    method: 'POST', headers: owner,
  })).status, 200);
  const reset = await request(server, '/api/platform/tenants/tenant-a/reset-supervisor-password', {
    method: 'POST', headers: owner, body: JSON.stringify({ password: 'ChangedPass!123' }),
  });
  assert.equal(reset.status, 200);
  assert.equal(one(db, 'SELECT session_version FROM users WHERE id=1').session_version, 4);
});

test('平台审核错误使用稳定状态码且不泄露 SQL 或哈希', async (t) => {
  const { server } = await fixture(t);
  const owner = authHeader({ id: 900, session_version: 1 });
  const result = await request(server, '/api/platform/applications/999/approve', {
    method: 'POST', headers: owner, body: JSON.stringify({ staffLimit: 4 }),
  });
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'APPLICATION_NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(result.body), /SELECT|password_hash|SQL/i);
});
