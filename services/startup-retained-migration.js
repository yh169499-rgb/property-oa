const { migrateRetainedTestData } = require('./retained-test-data');

async function runStartupRetainedMigration(options = {}) {
  const env = options.env || process.env;
  if (String(env.APPLY_RETAINED_TEST_DATA_ON_START || '').toLowerCase() !== 'true') {
    return { applied: false, reason: 'disabled' };
  }
  const password = String(env.RETAINED_TEST_PASSWORD || '');
  if (!password) throw new Error('缺少 RETAINED_TEST_PASSWORD');
  if (!options.db) throw new Error('缺少数据库实例');

  const migration = migrateRetainedTestData(options.db, {
    password,
    now: options.now || new Date(),
  });
  if (typeof options.persist === 'function') await options.persist();
  return { applied: true, summary: migration.summary };
}

module.exports = { runStartupRetainedMigration };

