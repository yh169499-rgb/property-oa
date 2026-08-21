const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const test = require('node:test');

const { createFullTestDB, one, rows } = require('./helpers/tenant-fixture');
const { runStartupPlatformBootstrap } = require('../services/startup-platform-bootstrap');

const env = {
  APPLY_PLATFORM_BOOTSTRAP_ON_START: 'true',
  PLATFORM_BOOTSTRAP_CONFIRM: 'PROVISION-PLATFORM-BOOTSTRAP',
  PLATFORM_PROVISIONING_SECRET: 'platform-provisioning-secret-0123456789012345',
  PLATFORM_OWNER_PASSWORD: 'OwnerPassword!123',
  BLANK_SUPERVISOR_PASSWORD: 'BlankPassword!123',
};

test('平台初始化创建平台运维账号和无业务数据的独立主管企业', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  let saves = 0;

  const result = await runStartupPlatformBootstrap({
    db,
    env,
    persist: async () => { saves += 1; },
    now: new Date('2026-08-21T00:00:00.000Z'),
  });

  assert.equal(result.applied, true);
  assert.equal(result.summary.platformOwner.created, true);
  assert.equal(result.summary.blankSupervisor.created, true);
  assert.equal(saves, 1);

  const owner = one(db, "SELECT phone,name,role,tenant_id,status FROM users WHERE phone='13222514178'");
  assert.deepEqual(owner, {
    phone: '13222514178', name: '句子工单管理员', role: 'platform_owner', tenant_id: null, status: 'active',
  });
  assert.equal(bcrypt.compareSync(env.PLATFORM_OWNER_PASSWORD,
    one(db, "SELECT password FROM users WHERE phone='13222514178'").password), true);

  const blank = one(db, "SELECT id,phone,name,role,tenant_id,status FROM users WHERE phone='17713302589'");
  assert.deepEqual(blank, {
    id: blank.id, phone: '17713302589', name: '发财', role: '主管', tenant_id: 'tenant-blank-17713302589', status: 'active',
  });
  assert.equal(bcrypt.compareSync(env.BLANK_SUPERVISOR_PASSWORD,
    one(db, "SELECT password FROM users WHERE phone='17713302589'").password), true);
  assert.deepEqual(one(db, "SELECT id,name,status,owner_user_id,staff_limit FROM tenants WHERE id='tenant-blank-17713302589'"), {
    id: 'tenant-blank-17713302589', name: '发财企业', status: 'active', owner_user_id: blank.id, staff_limit: 4,
  });
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM staff_profiles WHERE tenant_id='tenant-blank-17713302589'").count, 1);
  for (const table of ['communities', 'tickets', 'shift_assignments', 'attendance_records', 'performance_rule_versions', 'ai_report_analyses']) {
    assert.equal(one(db, `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id='tenant-blank-17713302589'`).count, 0, table);
  }
});

test('平台初始化重复执行幂等且不覆盖已有密码', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  let saves = 0;
  await runStartupPlatformBootstrap({ db, env, persist: async () => { saves += 1; } });
  const ownerHash = one(db, "SELECT password FROM users WHERE phone='13222514178'").password;
  const result = await runStartupPlatformBootstrap({
    db,
    env: { ...env, PLATFORM_OWNER_PASSWORD: 'DifferentPassword!456', BLANK_SUPERVISOR_PASSWORD: 'DifferentBlank!456' },
    persist: async () => { saves += 1; },
  });
  assert.equal(result.applied, true);
  assert.equal(result.summary.platformOwner.unchanged, true);
  assert.equal(result.summary.blankSupervisor.unchanged, true);
  assert.equal(saves, 1);
  assert.equal(one(db, "SELECT password FROM users WHERE phone='13222514178'").password, ownerHash);
  assert.equal(rows(db, "SELECT phone FROM users WHERE role='platform_owner' AND status='active'").length, 1);
});

test('平台初始化默认关闭，开启时要求确认口令和两个运行时密码', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  const disabled = await runStartupPlatformBootstrap({ db, env: {}, persist: async () => {} });
  assert.deepEqual(disabled, { applied: false, reason: 'disabled' });

  await assert.rejects(
    runStartupPlatformBootstrap({
      db,
      env: { ...env, PLATFORM_BOOTSTRAP_CONFIRM: 'wrong' },
      persist: async () => {},
    }),
    /确认口令/
  );
  await assert.rejects(
    runStartupPlatformBootstrap({
      db,
      env: { ...env, BLANK_SUPERVISOR_PASSWORD: '' },
      persist: async () => {},
    }),
    /BLANK_SUPERVISOR_PASSWORD/
  );
});

test('显式重置开关才会更新两个账号密码并撤销旧会话', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  let saves = 0;
  await runStartupPlatformBootstrap({ db, env, persist: async () => { saves += 1; } });
  const oldOwnerHash = one(db, "SELECT password FROM users WHERE phone='13222514178'").password;
  const oldBlankHash = one(db, "SELECT password FROM users WHERE phone='17713302589'").password;
  const resetEnv = {
    ...env,
    PLATFORM_BOOTSTRAP_RESET_PASSWORDS_ON_START: 'true',
    PLATFORM_OWNER_PASSWORD: 'ResetOwner!789',
    BLANK_SUPERVISOR_PASSWORD: 'ResetBlank!789',
  };
  const result = await runStartupPlatformBootstrap({
    db, env: resetEnv, persist: async () => { saves += 1; },
  });
  assert.equal(result.summary.platformOwner.passwordReset, true);
  assert.equal(result.summary.blankSupervisor.passwordReset, true);
  assert.equal(saves, 2);
  const owner = one(db, "SELECT password,session_version FROM users WHERE phone='13222514178'");
  const blank = one(db, "SELECT password,session_version FROM users WHERE phone='17713302589'");
  assert.notEqual(owner.password, oldOwnerHash);
  assert.notEqual(blank.password, oldBlankHash);
  assert.equal(bcrypt.compareSync(resetEnv.PLATFORM_OWNER_PASSWORD, owner.password), true);
  assert.equal(bcrypt.compareSync(resetEnv.BLANK_SUPERVISOR_PASSWORD, blank.password), true);
  assert.equal(owner.session_version, 2);
  assert.equal(blank.session_version, 2);
});
