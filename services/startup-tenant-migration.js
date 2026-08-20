const {
  DEFAULT_INPUT,
  applyTenantMigration,
  hasPendingTenantMigration,
  purgeOrphanAiReportCache,
} = require('./tenant-migration');

const CONFIRM_PHRASE = 'MIGRATE-MULTI-TENANT';

function runStartupTenantMigration(options = {}) {
  const env = options.env || process.env;
  if (String(env.APPLY_TENANT_MIGRATION_ON_START || '').toLowerCase() !== 'true') {
    return Promise.resolve({ applied: false, reason: 'disabled' });
  }
  if (!options.db) return Promise.reject(new Error('缺少数据库实例'));
  if (String(env.TENANT_MIGRATION_CONFIRM || '') !== CONFIRM_PHRASE) {
    return Promise.reject(new Error(`启动迁移必须提供确认口令 ${CONFIRM_PHRASE}`));
  }
  if (!hasPendingTenantMigration(options.db)) {
    return Promise.resolve({ applied: false, reason: 'already-migrated' });
  }

  const input = {
    testSupervisorPhone: env.TENANT_MIGRATION_SUPERVISOR_PHONE || DEFAULT_INPUT.testSupervisorPhone,
    testTenantId: env.TENANT_MIGRATION_TENANT_ID || DEFAULT_INPUT.testTenantId,
    testTenantName: env.TENANT_MIGRATION_TENANT_NAME || DEFAULT_INPUT.testTenantName,
    testStaffLimit: env.TENANT_MIGRATION_STAFF_LIMIT
      ? Number(env.TENANT_MIGRATION_STAFF_LIMIT) : DEFAULT_INPUT.testStaffLimit,
    nowIso: options.nowIso || new Date().toISOString(),
  };
  const db = options.db;
  db.run('SAVEPOINT startup_tenant_migration');
  try {
    const orphanAiReportsRemoved = purgeOrphanAiReportCache(db);
    const migration = applyTenantMigration(db, input);
    db.run('RELEASE SAVEPOINT startup_tenant_migration');
    const summary = { ...migration, orphanAiReportsRemoved };
    return Promise.resolve(typeof options.persist === 'function'
      ? Promise.resolve(options.persist()).then(() => ({ applied: true, summary }))
      : { applied: true, summary });
  } catch (error) {
    try {
      db.run('ROLLBACK TO SAVEPOINT startup_tenant_migration');
      db.run('RELEASE SAVEPOINT startup_tenant_migration');
    } catch (_) {}
    throw error;
  }
}

module.exports = { CONFIRM_PHRASE, runStartupTenantMigration };
