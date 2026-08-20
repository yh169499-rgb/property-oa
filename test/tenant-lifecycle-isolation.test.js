const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFullTestDB,
  one,
} = require('./helpers/tenant-fixture');
const {
  normalizeStaffLimit,
  teamUsage,
  assertTeamCapacity,
} = require('../services/team-capacity');
const {
  createStaffAccount,
  approvePendingRegistration,
  departStaff,
} = require('../services/staff-lifecycle');

async function fixture() {
  const db = await createFullTestDB();
  db.run(`
    INSERT INTO tenants (id, name, status, owner_user_id, staff_limit, created_at, updated_at)
      VALUES ('tenant-a', '甲企业', 'active', 1, 2, 'test', 'test'),
             ('tenant-b', '乙企业', 'active', 2, 2, 'test', 'test');
    INSERT INTO users (id, phone, password, name, role, status, tenant_id, session_version)
      VALUES (1, '13900000001', 'hash', '甲主管', '主管', 'active', 'tenant-a', 0),
             (2, '13900000002', 'hash', '乙主管', '主管', 'active', 'tenant-b', 0);
    INSERT INTO staff_profiles
      (id, tenant_id, user_id, name, phone, position, manager_id, employment_status)
      VALUES (11, 'tenant-a', 1, '甲主管', '13900000001', '主管', NULL, 'active'),
             (21, 'tenant-b', 2, '乙主管', '13900000002', '主管', NULL, 'active');
    UPDATE tenants SET owner_user_id = CASE id WHEN 'tenant-a' THEN 1 ELSE 2 END;
    INSERT INTO communities (id, tenant_id, name, created)
      VALUES ('a-main', 'tenant-a', '甲小区', 'test'), ('b-main', 'tenant-b', '乙小区', 'test');
    INSERT INTO pending_registrations
      (id, tenant_id, phone, password, name, role, skill, community_id, status, created)
      VALUES (101, 'tenant-a', '13900000101', 'pending-a', '甲师傅', 'worker', '综合维修', 'a-main', 'pending', 'test'),
             (102, 'tenant-b', '13900000102', 'pending-b', '乙师傅', 'worker', '综合维修', 'b-main', 'pending', 'test');
  `);
  return db;
}

test('人员上限只接受 1—999 整数，且不再按岗位比例拆分', () => {
  assert.equal(normalizeStaffLimit('8'), 8);
  assert.throws(() => normalizeStaffLimit(0), error => error.code === 'INVALID_STAFF_LIMIT');
  assert.throws(() => normalizeStaffLimit(1000), error => error.code === 'INVALID_STAFF_LIMIT');
  assert.throws(() => normalizeStaffLimit(2.5), error => error.code === 'INVALID_STAFF_LIMIT');
});

test('团队用量按企业统计在职普通人员并返回剩余名额', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const usage = teamUsage(db, 'tenant-a');
  assert.deepEqual(usage, { activeCount: 0, limit: 2, remaining: 2 });
  assert.deepEqual(assertTeamCapacity(db, 'tenant-a'), usage);
});

test('创建人员只能进入当前主管企业并受企业总人数上限约束', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const first = createStaffAccount(db, {
    phone: '13900000111', passwordHash: 'hash', name: '甲管家', role: 'keeper',
    skill: '', communityId: 'a-main',
  }, { id: 1, role: '主管', tenant_id: 'tenant-a' });
  assert.equal(one(db, 'SELECT tenant_id FROM users WHERE id=?', [first.userId]).tenant_id, 'tenant-a');
  assert.equal(one(db, 'SELECT tenant_id FROM staff_profiles WHERE id=?', [first.profileId]).tenant_id, 'tenant-a');
  assert.throws(() => createStaffAccount(db, {
    phone: '13900000112', passwordHash: 'hash', name: '越权人员', role: 'worker',
    skill: '', communityId: 'b-main',
  }, { id: 1, role: '主管', tenant_id: 'tenant-a' }), error => error.code === 'COMMUNITY_NOT_FOUND');
  createStaffAccount(db, {
    phone: '13900000112', passwordHash: 'hash', name: '甲师傅二', role: 'worker',
    skill: '', communityId: 'a-main',
  }, { id: 1, role: '主管', tenant_id: 'tenant-a' });
  assert.throws(() => createStaffAccount(db, {
    phone: '13900000113', passwordHash: 'hash', name: '甲师傅二', role: 'worker',
    skill: '', communityId: 'a-main',
  }, { id: 1, role: '主管', tenant_id: 'tenant-a' }), error => error.code === 'TEAM_CAPACITY_FULL');
  assert.deepEqual(teamUsage(db, 'tenant-a'), { activeCount: 2, limit: 2, remaining: 0 });
});

test('主管只能审批本企业申请，审批过程仍受同租户人数上限约束', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  assert.throws(
    () => approvePendingRegistration(db, 102, { id: 1, role: '主管', tenant_id: 'tenant-a' }),
    error => error.code === 'REGISTRATION_NOT_FOUND' || error.code === 'CROSS_TENANT_REGISTRATION_FORBIDDEN'
  );
  const approved = approvePendingRegistration(db, 101, { id: 1, role: '主管', tenant_id: 'tenant-a' });
  assert.equal(approved.communityId, 'a-main');
  assert.equal(one(db, 'SELECT tenant_id FROM users WHERE id=?', [approved.userId]).tenant_id, 'tenant-a');
  assert.equal(one(db, 'SELECT status FROM pending_registrations WHERE id=101').status, 'approved');
  assert.equal(one(db, 'SELECT status FROM pending_registrations WHERE id=102').status, 'pending');
});

test('离职只能处理同租户普通人员，删除登录但保留历史工单和人员档案', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const staff = createStaffAccount(db, {
    phone: '13900000121', passwordHash: 'hash', name: '甲师傅', role: 'worker',
    skill: '综合维修', communityId: 'a-main',
  }, { id: 1, role: '主管', tenant_id: 'tenant-a' });
  db.run(`INSERT INTO tickets
    (id, tenant_id, worker, assignee_user_id, assignee_staff_profile_id, created)
    VALUES ('history-a', 'tenant-a', '甲师傅', ?, ?, 'test')`, [staff.userId, staff.profileId]);
  assert.throws(
    () => departStaff(db, 2, { id: 1, role: '主管', tenant_id: 'tenant-a' }),
    error => error.code === 'USER_NOT_FOUND' || error.code === 'CROSS_TENANT_USER_FORBIDDEN'
  );
  const departed = departStaff(db, staff.userId, { id: 1, role: '主管', tenant_id: 'tenant-a', nowIso: 'test' });
  assert.equal(departed.departed, true);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM users WHERE id=?', [staff.userId]).count, 0);
  assert.equal(one(db, 'SELECT employment_status FROM staff_profiles WHERE id=?', [staff.profileId]).employment_status, 'departed');
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM tickets WHERE id=?', ['history-a']).count, 1);
  const audit = one(db, 'SELECT tenant_id FROM staff_lifecycle_audit WHERE target_user_id=?', [staff.userId]);
  assert.equal(audit.tenant_id, 'tenant-a');
  assert.deepEqual(teamUsage(db, 'tenant-a'), { activeCount: 0, limit: 2, remaining: 2 });
});
