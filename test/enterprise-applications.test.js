const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createFullTestDB, one, rows } = require('./helpers/tenant-fixture');
const {
  submitEnterpriseApplication,
  approveEnterpriseApplication,
  rejectEnterpriseApplication,
} = require('../services/enterprise-applications');

const OWNER = Object.freeze({ id: 900, role: 'platform_owner', tenant_id: '' });

test('企业申请只保存 bcrypt 哈希，通过后原子创建空企业和唯一主管', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  const application = await submitEnterpriseApplication(db, {
    enterpriseName: '甲物业',
    supervisorName: '甲主管',
    phone: '13900000001',
    password: 'SecurePass!123',
  }, { nowIso: '2026-08-20T00:00:00.000Z' });
  const stored = one(db, 'SELECT * FROM enterprise_applications WHERE id=?', [application.id]);
  assert.notEqual(stored.password_hash, 'SecurePass!123');
  assert.equal(await bcrypt.compare('SecurePass!123', stored.password_hash), true);

  const approved = approveEnterpriseApplication(db, application.id, OWNER, {
    staffLimit: 12,
    nowIso: '2026-08-20T01:00:00.000Z',
    tenantId: 'tenant-a',
  });
  assert.deepEqual(approved, { tenantId: 'tenant-a', userId: approved.userId, staffLimit: 12 });
  assert.equal(one(db, 'SELECT owner_user_id FROM tenants WHERE id=?', ['tenant-a']).owner_user_id, approved.userId);
  assert.equal(one(db, 'SELECT staff_limit FROM tenants WHERE id=?', ['tenant-a']).staff_limit, 12);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM users WHERE tenant_id=?', ['tenant-a']).count, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM staff_profiles WHERE tenant_id=?', ['tenant-a']).count, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM communities WHERE tenant_id=?', ['tenant-a']).count, 0);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM tickets WHERE tenant_id=?', ['tenant-a']).count, 0);
  assert.equal(one(db, 'SELECT password_hash FROM enterprise_applications WHERE id=?', [application.id]).password_hash, '');
  const audit = one(db, "SELECT * FROM platform_audit_logs WHERE action='enterprise.approve'");
  assert.equal(JSON.stringify(audit).includes('SecurePass!123'), false);
  assert.equal(JSON.stringify(audit).includes(stored.password_hash), false);
});

test('重复申请、手机号占用、重复审核均稳定冲突且不创建第二企业', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  const input = {
    enterpriseName: '乙物业', supervisorName: '乙主管',
    phone: '13900000002', password: 'SecurePass!456',
  };
  const application = await submitEnterpriseApplication(db, input);
  await assert.rejects(() => submitEnterpriseApplication(db, input), error => error.code === 'APPLICATION_PENDING');
  approveEnterpriseApplication(db, application.id, OWNER, { tenantId: 'tenant-b' });
  assert.throws(
    () => approveEnterpriseApplication(db, application.id, OWNER, { tenantId: 'tenant-c' }),
    error => error.code === 'APPLICATION_ALREADY_REVIEWED'
  );
  await assert.rejects(
    () => submitEnterpriseApplication(db, { ...input, enterpriseName: '另一个企业' }),
    error => error.code === 'PHONE_IN_USE'
  );
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM tenants').count, 1);
});

test('拒绝必须给出原因、清空凭据并记录脱敏平台审计', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  const application = await submitEnterpriseApplication(db, {
    enterpriseName: '丙物业', supervisorName: '丙主管',
    phone: '13900000003', password: 'SecurePass!789',
  });
  assert.throws(
    () => rejectEnterpriseApplication(db, application.id, OWNER, { reason: '  ' }),
    error => error.code === 'REJECTION_REASON_REQUIRED'
  );
  const rejected = rejectEnterpriseApplication(db, application.id, OWNER, {
    reason: '资料不完整\n请补充', nowIso: '2026-08-20T02:00:00.000Z',
  });
  assert.equal(rejected.status, 'rejected');
  const stored = one(db, 'SELECT * FROM enterprise_applications WHERE id=?', [application.id]);
  assert.equal(stored.password_hash, '');
  assert.equal(stored.rejection_reason.includes('\n'), false);
  const audits = rows(db, "SELECT * FROM platform_audit_logs WHERE action='enterprise.reject'");
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits).toLowerCase().includes('password'), false);
});

test('只有无企业归属的平台运维可审核，人员上限严格限制为 1—999 整数', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  const application = await submitEnterpriseApplication(db, {
    enterpriseName: '丁物业', supervisorName: '丁主管',
    phone: '13900000004', password: 'SecurePass!000',
  });
  for (const actor of [
    { id: 1, role: '主管', tenant_id: 'tenant-a' },
    { id: 900, role: 'platform_owner', tenant_id: 'tenant-a' },
  ]) {
    assert.throws(
      () => approveEnterpriseApplication(db, application.id, actor),
      error => error.code === 'PLATFORM_OWNER_REQUIRED'
    );
  }
  for (const staffLimit of [0, 1000, 1.5, '4.5']) {
    assert.throws(
      () => approveEnterpriseApplication(db, application.id, OWNER, { staffLimit }),
      error => error.code === 'INVALID_STAFF_LIMIT'
    );
  }
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM tenants').count, 0);
});
