const assert = require('node:assert/strict');
const test = require('node:test');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema, backfillDefaultPerformanceRules } = require('../workforce-schema');
const { runStartupRetainedMigration } = require('../services/startup-retained-migration');

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker',
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  db.run(`CREATE TABLE tickets (
    id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '', desc TEXT DEFAULT '',
    loc TEXT DEFAULT '', priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'wait', worker TEXT DEFAULT '',
    message TEXT DEFAULT '', created TEXT DEFAULT '', finished TEXT DEFAULT '', reject_reason TEXT DEFAULT '',
    estimated_hours REAL DEFAULT 0, session_id TEXT DEFAULT '', community_id TEXT DEFAULT 'default',
    repeat_key TEXT DEFAULT '', repeat_of TEXT DEFAULT '', repeat_count INTEGER DEFAULT 1,
    is_recurring INTEGER DEFAULT 0, recurrence_note TEXT DEFAULT '', feedback_count INTEGER DEFAULT 1,
    metadata TEXT DEFAULT '{}'
  )`);
  db.run(`CREATE TABLE communities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '', created TEXT NOT NULL
  )`);
  ensureWorkforceSchema(db);
  backfillDefaultPerformanceRules(db);
  return db;
}

test('启动迁移默认关闭且不会写入任何测试账号', async () => {
  const db = await fixture();
  let saves = 0;
  const result = await runStartupRetainedMigration({ db, env: {}, persist: async () => { saves += 1; } });
  assert.deepEqual(result, { applied: false, reason: 'disabled' });
  assert.equal(db.exec('SELECT COUNT(*) FROM users')[0].values[0][0], 0);
  assert.equal(saves, 0);
});

test('启动迁移必须同时提供运行时密码，且成功后持久化一次', async () => {
  const db = await fixture();
  await assert.rejects(
    runStartupRetainedMigration({ db, env: { APPLY_RETAINED_TEST_DATA_ON_START: 'true' }, persist: async () => {} }),
    /RETAINED_TEST_PASSWORD/
  );

  let saves = 0;
  const result = await runStartupRetainedMigration({
    db,
    env: {
      APPLY_RETAINED_TEST_DATA_ON_START: 'true',
      RETAINED_TEST_PASSWORD: 'runtime-only-password',
    },
    now: new Date('2026-08-13T06:00:00.000Z'),
    persist: async () => { saves += 1; },
  });
  assert.equal(result.applied, true);
  assert.equal(result.summary.retainedAccounts, 5);
  assert.ok(result.summary.mockTickets >= 1);
  assert.equal(saves, 1);
  assert.equal(db.exec("SELECT COUNT(*) FROM users WHERE status = 'active'")[0].values[0][0], 5);
});
