const test = require('node:test');
const assert = require('node:assert/strict');
const { createFullTestDB, one } = require('./helpers/tenant-fixture');
const { runStartupTenantMigration } = require('../services/startup-tenant-migration');

async function legacyFixture() {
  const db = await createFullTestDB();
  db.run(`INSERT INTO users (id, phone, password, name, role, status, tenant_id)
    VALUES (1, '13800000001', 'hash', '测试主管', '主管', 'active', '')`);
  db.run(`INSERT INTO staff_profiles
    (id, tenant_id, user_id, name, employment_status, created_at, updated_at)
    VALUES (1, '', 1, '测试主管', 'active', 'old', 'old')`);
  db.run(`INSERT INTO communities (id, name, created, tenant_id)
    VALUES ('default', '默认小区', 'old', '')`);
  return db;
}

test('启动租户迁移默认关闭且不会写入', async () => {
  const db = await legacyFixture();
  const before = Buffer.from(db.export());
  const result = await runStartupTenantMigration({ db, env: {} });
  assert.deepEqual(result, { applied: false, reason: 'disabled' });
  assert.deepEqual(Buffer.from(db.export()), before);
});

test('启动租户迁移需要确认口令', async () => {
  const db = await legacyFixture();
  await assert.rejects(
    runStartupTenantMigration({
      db,
      env: { APPLY_TENANT_MIGRATION_ON_START: 'true' },
    }),
    /MIGRATE-MULTI-TENANT/
  );
});

test('开启并确认后自动迁移、持久化且可重复启动', async () => {
  const db = await legacyFixture();
  let saves = 0;
  const env = {
    APPLY_TENANT_MIGRATION_ON_START: 'true',
    TENANT_MIGRATION_CONFIRM: 'MIGRATE-MULTI-TENANT',
  };
  const first = await runStartupTenantMigration({
    db,
    env,
    persist: async () => { saves += 1; },
  });
  assert.equal(first.applied, true);
  assert.equal(saves, 1);
  assert.equal(one(db, "SELECT tenant_id FROM users WHERE id=1").tenant_id, 'tenant-test');

  const second = await runStartupTenantMigration({
    db,
    env,
    persist: async () => { saves += 1; },
  });
  assert.deepEqual(second, { applied: false, reason: 'already-migrated' });
  assert.equal(saves, 1);
});

test('启动迁移清理无法关联人员或小区的 AI 缓存后继续迁移', async () => {
  const db = await legacyFixture();
  db.run(`INSERT INTO ai_report_analyses (
      tenant_id, staff_profile_id, community_id, range_from, range_to,
      report_hash, model, prompt_version, analysis_json, created_at
    ) VALUES ('', 999, 'missing-community', '2026-08-01', '2026-08-05',
      'orphan-hash', 'qwen', 'v1', '{}', 'old')`);
  const result = await runStartupTenantMigration({
    db,
    env: {
      APPLY_TENANT_MIGRATION_ON_START: 'true',
      TENANT_MIGRATION_CONFIRM: 'MIGRATE-MULTI-TENANT',
    },
    persist: async () => {},
  });
  assert.equal(result.applied, true);
  assert.equal(result.summary.orphanAiReportsRemoved, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM ai_report_analyses').count, 0);
});
