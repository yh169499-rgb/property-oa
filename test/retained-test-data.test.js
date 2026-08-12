const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { ensureWorkforceSchema } = require('../workforce-schema');

let SQL;

test.before(async () => {
  SQL = await initSqlJs();
});

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function createFixture() {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker',
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'repair',
      cat TEXT NOT NULL DEFAULT '其他',
      desc TEXT DEFAULT '',
      loc TEXT DEFAULT '',
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'wait',
      worker TEXT DEFAULT '',
      message TEXT DEFAULT '',
      created TEXT NOT NULL,
      finished TEXT DEFAULT '',
      reject_reason TEXT DEFAULT '',
      estimated_hours REAL DEFAULT 0,
      community_id TEXT DEFAULT 'default',
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE communities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      created TEXT NOT NULL
    );
    CREATE TABLE staff_status (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'on',
      updated TEXT
    );
    CREATE TABLE pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker',
      community_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created TEXT NOT NULL
    );
  `);
  ensureWorkforceSchema(db);
  db.run("INSERT INTO communities (id, name, created) VALUES ('default', '默认小区', '2025-01-01T00:00:00.000Z')");
  const password = bcrypt.hashSync('old-secret', 4);
  for (let index = 1; index <= 7; index += 1) {
    const phone = `1380000000${index}`;
    const role = index === 1 ? 'lead' : (index <= 5 ? 'worker' : 'keeper');
    db.run('INSERT INTO users (phone, password, name, role) VALUES (?, ?, ?, ?)', [
      phone, password, `旧姓名${index}`, role,
    ]);
  }
  db.run("INSERT INTO users (phone, password, name, role) VALUES ('13900000000', ?, '历史人员', '主管')", [password]);
  const legacyUser = Number(one(db, "SELECT id FROM users WHERE phone = '13900000000'").id);
  db.run(`INSERT INTO staff_profiles
    (user_id, name, phone, position, employment_status, created_at, updated_at)
    VALUES (?, '历史人员', '13900000000', '旧主管', 'active', '2025-01-01', '2025-01-01')`, [legacyUser]);
  const legacyProfile = Number(one(db, 'SELECT id FROM staff_profiles WHERE user_id = ?', [legacyUser]).id);
  db.run("INSERT INTO community_memberships (community_id, staff_profile_id, created_at) VALUES ('default', ?, '2025-01-01')", [legacyProfile]);
  db.run("INSERT INTO shift_assignments (staff_id, work_date, note) VALUES (?, '2026-08-12', '旧排班')", [legacyProfile]);
  db.run("INSERT INTO attendance_records (staff_id, work_date, status) VALUES (?, '2026-08-12', 'normal')", [legacyProfile]);
  db.run("INSERT INTO staff_status (name, status) VALUES ('历史人员', 'on')");
  db.run(`INSERT INTO tickets
    (id, desc, created, worker, assignee_user_id, performance_rule_version_id)
    VALUES ('REAL-HISTORY-001', '历史工单', '2025-01-01T00:00:00.000Z', '历史人员', ?, 1)`, [legacyUser]);
  db.run(`INSERT INTO ticket_activity_logs
    (ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)
    VALUES ('REAL-HISTORY-001', ?, ?, 'assign', '{}', '2025-01-01T01:00:00.000Z')`, [legacyUser, legacyProfile]);
  return db;
}

function options() {
  return {
    password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  };
}

test('固定清单只包含一个主管、四个师傅和两个管家', () => {
  const { RETAINED_ACCOUNTS } = require('../services/retained-test-data');
  assert.deepEqual(RETAINED_ACCOUNTS.map(({ phone, role }) => [phone, role]), [
    ['13800000001', '主管'],
    ['13800000002', 'worker'],
    ['13800000003', 'worker'],
    ['13800000004', 'worker'],
    ['13800000005', 'worker'],
    ['13800000006', 'keeper'],
    ['13800000007', 'keeper'],
  ]);
});

test('预演摘要不包含密码、哈希或令牌', () => {
  const { planRetainedTestData } = require('../services/retained-test-data');
  const result = planRetainedTestData(createFixture(), options());
  assert.equal(result.summary.retainedAccounts, 7);
  assert.equal(result.summary.disabledAccounts, 1);
  assert.doesNotMatch(JSON.stringify(result.summary), /runtime-secret|password|hash|token/i);
});

test('只激活固定账号并停用其他账号但保留历史工单和活动', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  const historyBefore = one(db, "SELECT * FROM tickets WHERE id = 'REAL-HISTORY-001'");
  const activityBefore = one(db, "SELECT * FROM ticket_activity_logs WHERE ticket_id = 'REAL-HISTORY-001'");
  migrateRetainedTestData(db, options());

  assert.deepEqual(rows(db,
    "SELECT phone, role, status FROM users WHERE status = 'active' ORDER BY phone"
  ).map(row => [row.phone, row.role, row.status]), [
    ['13800000001', '主管', 'active'],
    ['13800000002', 'worker', 'active'],
    ['13800000003', 'worker', 'active'],
    ['13800000004', 'worker', 'active'],
    ['13800000005', 'worker', 'active'],
    ['13800000006', 'keeper', 'active'],
    ['13800000007', 'keeper', 'active'],
  ]);
  assert.equal(one(db, "SELECT status FROM users WHERE phone = '13900000000'").status, 'disabled');
  assert.equal(rows(db, "SELECT id FROM shift_assignments WHERE note = '旧排班'").length, 0);
  assert.equal(rows(db, "SELECT id FROM attendance_records WHERE status = 'normal'").length, 0);
  assert.equal(rows(db, "SELECT name FROM staff_status WHERE name = '历史人员'").length, 0);
  assert.deepEqual(one(db, "SELECT * FROM tickets WHERE id = 'REAL-HISTORY-001'"), historyBefore);
  assert.deepEqual(one(db, "SELECT * FROM ticket_activity_logs WHERE ticket_id = 'REAL-HISTORY-001'"), activityBefore);
  for (const user of rows(db, "SELECT password FROM users WHERE status = 'active'")) {
    assert.equal(bcrypt.compareSync('runtime-secret', user.password), true);
  }
});

test('固定账号各有一个 active 档案并统一归主管管理', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const profiles = rows(db, `SELECT u.phone, sp.name, sp.position, sp.employment_status,
    manager.phone AS manager_phone
    FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
    LEFT JOIN staff_profiles manager_profile ON manager_profile.id = sp.manager_id
    LEFT JOIN users manager ON manager.id = manager_profile.user_id
    WHERE u.status = 'active' ORDER BY u.phone`);
  assert.equal(profiles.length, 7);
  assert.equal(profiles[0].manager_phone, null);
  assert.ok(profiles.slice(1).every(profile => profile.manager_phone === '13800000001'));
  assert.ok(profiles.every(profile => profile.employment_status === 'active'));
});

test('重复迁移不会重复创建档案、小区和成员关系', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const first = rows(db, `SELECT
    (SELECT COUNT(*) FROM staff_profiles) AS profiles,
    (SELECT COUNT(*) FROM communities) AS communities,
    (SELECT COUNT(*) FROM community_memberships) AS memberships`)[0];
  migrateRetainedTestData(db, options());
  const second = rows(db, `SELECT
    (SELECT COUNT(*) FROM staff_profiles) AS profiles,
    (SELECT COUNT(*) FROM communities) AS communities,
    (SELECT COUNT(*) FROM community_memberships) AS memberships`)[0];
  assert.deepEqual(second, first);
});

