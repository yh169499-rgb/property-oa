const { ensureStandaloneManager } = require('./standalone-manager');

async function runStartupStandaloneManager(options = {}) {
  const env = options.env || process.env;
  if (String(env.APPLY_STANDALONE_MANAGER_ON_START || '').toLowerCase() !== 'true') {
    return { applied: false, reason: 'disabled' };
  }
  if (!options.db) throw new Error('缺少数据库实例');
  const password = String(env.STANDALONE_MANAGER_PASSWORD || '');
  if (!password) throw new Error('缺少 STANDALONE_MANAGER_PASSWORD');
  const result = ensureStandaloneManager(options.db, {
    phone: env.STANDALONE_MANAGER_PHONE || '13222514178',
    name: env.STANDALONE_MANAGER_NAME || '发财',
    password,
    now: options.now || new Date(),
  });
  if ((result.created || result.updated) && typeof options.persist === 'function') {
    await options.persist();
  }
  return { applied: true, summary: result };
}

module.exports = { runStartupStandaloneManager };
