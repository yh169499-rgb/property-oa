const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createFullTestDB, one } = require('./helpers/tenant-fixture');
const { provisionPlatformOwner } = require('../services/platform-provisioning');

const baseInput = Object.freeze({
  secret: 'provision-secret-that-is-at-least-32-characters',
  expectedSecret: 'provision-secret-that-is-at-least-32-characters',
  phone: '13222514178',
  name: '句子工单管理员',
  password: 'OwnerSecure!123',
  nowIso: '2026-08-20T00:00:00.000Z',
});

test('平台运维初始化创建无租户账号且重复运行幂等', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  const first = await provisionPlatformOwner(db, baseInput);
  const second = await provisionPlatformOwner(db, baseInput);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.unchanged, true);
  assert.equal(first.userId, second.userId);
  const user = one(db, 'SELECT * FROM users WHERE id=?', [first.userId]);
  assert.equal(user.role, 'platform_owner');
  assert.equal(user.tenant_id, null);
  assert.equal(user.status, 'active');
  assert.equal(await bcrypt.compare(baseInput.password, user.password), true);
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM users WHERE role='platform_owner' AND status='active'").count, 1);
});

test('初始化拒绝错误或过短保护密钥，且不产生任何账号', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  for (const input of [
    { ...baseInput, secret: 'wrong-secret' },
    { ...baseInput, expectedSecret: 'short', secret: 'short' },
  ]) {
    await assert.rejects(
      () => provisionPlatformOwner(db, input),
      error => error.code === 'PROVISIONING_FORBIDDEN' || error.code === 'INVALID_PROVISIONING_SECRET'
    );
  }
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM users').count, 0);
});

test('已有企业账号手机号不可提权，已有其他平台运维也不可创建第二个', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  db.run(`INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at)
    VALUES('tenant-a','甲企业','active',4,'test','test')`);
  db.run(`INSERT INTO users(phone,password,name,role,status,tenant_id,session_version)
    VALUES('13222514178','hash','企业主管','主管','active','tenant-a',1)`);
  await assert.rejects(
    () => provisionPlatformOwner(db, baseInput),
    error => error.code === 'PLATFORM_OWNER_PHONE_CONFLICT'
  );
  db.run('DELETE FROM users');
  db.run(`INSERT INTO users(phone,password,name,role,status,tenant_id,session_version)
    VALUES('13900000000','hash','既有平台运维','platform_owner','active',NULL,1)`);
  await assert.rejects(
    () => provisionPlatformOwner(db, baseInput),
    error => error.code === 'PLATFORM_OWNER_ALREADY_EXISTS'
  );
});

test('初始化输入严格校验固定角色所需的手机号、姓名和强密码', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  for (const [field, value] of [
    ['phone', '123'], ['name', ''], ['password', 'short'],
  ]) {
    await assert.rejects(
      () => provisionPlatformOwner(db, { ...baseInput, [field]: value }),
      error => error.code === 'INVALID_PLATFORM_OWNER_INPUT'
    );
  }
});
