const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createFullTestDB, one } = require('./helpers/tenant-fixture');
const {
  listTenants,
  updateTenant,
  setTenantStatus,
  resetTenantSupervisorPassword,
} = require('../services/platform-tenants');

const OWNER = Object.freeze({ id: 900, role: 'platform_owner', tenant_id: '' });

async function fixture() {
  const db = await createFullTestDB();
  db.run(`
    INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at)
      VALUES('tenant-a','甲企业','active',4,'2026-08-01','2026-08-01'),
            ('tenant-b','乙企业','active',7,'2026-08-02','2026-08-02');
    INSERT INTO users(id,phone,password,name,role,status,tenant_id,session_version,last_login_at)
      VALUES(1,'13800000001','hash','甲主管','主管','active','tenant-a',1,'2026-08-20'),
            (2,'13800000002','hash','甲师傅','worker','active','tenant-a',1,NULL),
            (3,'13800000003','hash','甲离职','worker','disabled','tenant-a',2,NULL),
            (101,'13900000001','hash','乙主管','主管','active','tenant-b',1,NULL);
    UPDATE tenants SET owner_user_id=CASE id WHEN 'tenant-a' THEN 1 ELSE 101 END;
    INSERT INTO staff_profiles(tenant_id,user_id,name,position,employment_status,created_at,updated_at)
      VALUES('tenant-a',1,'甲主管','主管','active','test','test'),
            ('tenant-a',2,'甲师傅','维修师傅','active','test','test'),
            ('tenant-a',3,'甲离职','维修师傅','departed','test','test'),
            ('tenant-b',101,'乙主管','主管','active','test','test');
    INSERT INTO communities(id,tenant_id,name,created) VALUES
      ('a-1','tenant-a','甲小区','test'),('b-1','tenant-b','乙小区','test');
    INSERT INTO tickets(id,tenant_id,type,created) VALUES
      ('A-1','tenant-a','repair','test'),('B-1','tenant-b','help','test');
  `);
  return db;
}

test('企业列表只返回运维元数据和租户内准确计数', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const tenants = listTenants(db, OWNER);
  assert.deepEqual(tenants.map(item => item.id), ['tenant-a', 'tenant-b']);
  assert.deepEqual(tenants[0], {
    id: 'tenant-a', name: '甲企业', status: 'active', created_at: '2026-08-01',
    supervisor_name: '甲主管', supervisor_phone: '13800000001',
    supervisor_last_login_at: '2026-08-20', active_staff_count: 1,
    staff_limit: 4, community_count: 1, ticket_count: 1,
  });
  assert.equal(JSON.stringify(tenants).includes('hash'), false);
});

test('修改企业名称与人员上限同事务完成，低于在职人数时全部回滚', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const updated = updateTenant(db, 'tenant-a', OWNER, {
    name: '甲物业集团', staffLimit: 8, nowIso: '2026-08-20T01:00:00.000Z',
  });
  assert.equal(updated.name, '甲物业集团');
  assert.equal(updated.staff_limit, 8);
  assert.throws(
    () => updateTenant(db, 'tenant-a', OWNER, { name: '不应保存', staffLimit: 0 }),
    error => error.code === 'INVALID_STAFF_LIMIT'
  );
  assert.equal(one(db, "SELECT name FROM tenants WHERE id='tenant-a'").name, '甲物业集团');
  assert.throws(
    () => updateTenant(db, 'tenant-a', OWNER, { name: '仍不应保存', staffLimit: 0 }),
    error => error.code === 'INVALID_STAFF_LIMIT'
  );
  const audit = one(db, "SELECT before_json,after_json FROM platform_audit_logs WHERE action='tenant.update'");
  assert.deepEqual(JSON.parse(audit.before_json), { name: '甲企业', staffLimit: 4 });
  assert.deepEqual(JSON.parse(audit.after_json), { name: '甲物业集团', staffLimit: 8 });
});

test('人员上限不能低于当前在职普通人员总数', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  db.run(`INSERT INTO users(phone,password,name,role,status,tenant_id,session_version)
    VALUES('13800000004','hash','甲管家','keeper','active','tenant-a',1)`);
  const userId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
  db.run(`INSERT INTO staff_profiles(tenant_id,user_id,name,position,employment_status)
    VALUES('tenant-a',?,'甲管家','物业管家','active')`, [userId]);
  assert.throws(
    () => updateTenant(db, 'tenant-a', OWNER, { name: '不能部分保存', staffLimit: 1 }),
    error => error.code === 'STAFF_LIMIT_BELOW_ACTIVE_COUNT' && error.status === 409
  );
  assert.deepEqual(one(db, "SELECT name,staff_limit FROM tenants WHERE id='tenant-a'"), {
    name: '甲企业', staff_limit: 4,
  });
});

test('停用和恢复企业使全部旧会话失效，数据保持不删除', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const disabled = setTenantStatus(db, 'tenant-a', OWNER, 'disabled', {
    nowIso: '2026-08-20T02:00:00.000Z',
  });
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(
    db.exec("SELECT id,session_version FROM users WHERE tenant_id='tenant-a' ORDER BY id")[0].values,
    [[1, 2], [2, 2], [3, 3]]
  );
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM tickets WHERE tenant_id='tenant-a'").count, 1);
  const restored = setTenantStatus(db, 'tenant-a', OWNER, 'active', {
    nowIso: '2026-08-20T03:00:00.000Z',
  });
  assert.equal(restored.status, 'active');
  assert.deepEqual(
    db.exec("SELECT id,session_version FROM users WHERE tenant_id='tenant-a' ORDER BY id")[0].values,
    [[1, 3], [2, 3], [3, 4]]
  );
});

test('重置主管密码只影响目标企业唯一主管并撤销旧会话', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const result = await resetTenantSupervisorPassword(db, 'tenant-a', OWNER, {
    password: 'NewSupervisor!123', nowIso: '2026-08-20T04:00:00.000Z',
  });
  assert.equal(result.supervisorUserId, 1);
  const target = one(db, 'SELECT password,session_version FROM users WHERE id=1');
  assert.equal(await bcrypt.compare('NewSupervisor!123', target.password), true);
  assert.equal(target.session_version, 2);
  assert.equal(one(db, 'SELECT session_version FROM users WHERE id=101').session_version, 1);
  const audit = one(db, "SELECT * FROM platform_audit_logs WHERE action='tenant.reset_supervisor_password'");
  assert.equal(JSON.stringify(audit).includes('NewSupervisor!123'), false);
  assert.equal(JSON.stringify(audit).includes(target.password), false);
});

test('企业维护服务拒绝企业主管和绑定企业的平台角色', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  for (const actor of [
    { id: 1, role: '主管', tenant_id: 'tenant-a' },
    { id: 900, role: 'platform_owner', tenant_id: 'tenant-a' },
  ]) {
    assert.throws(() => listTenants(db, actor), error => error.code === 'PLATFORM_OWNER_REQUIRED');
  }
});
