const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { ensureWorkforceSchema, backfillDefaultPerformanceRules } = require('../workforce-schema');
const { backfillTicketAssignees } = require('../services/workforce-migration');

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
      repeat_key TEXT DEFAULT '',
      repeat_of TEXT DEFAULT '',
      repeat_count INTEGER DEFAULT 1,
      is_recurring INTEGER DEFAULT 0,
      recurrence_note TEXT DEFAULT '',
      feedback_count INTEGER DEFAULT 1,
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
  db.run(`INSERT INTO staff_profiles
    (user_id, name, phone, position, employment_status, created_at, updated_at)
    VALUES (NULL, '无账号旧档案', '', '旧人员', 'active', '2025-01-01', '2025-01-01')`);
  const orphanProfile = Number(one(db, "SELECT id FROM staff_profiles WHERE name = '无账号旧档案'").id);
  db.run("INSERT INTO community_memberships (community_id, staff_profile_id, created_at) VALUES ('default', ?, '2025-01-01')", [legacyProfile]);
  db.run("INSERT INTO community_memberships (community_id, staff_profile_id, created_at) VALUES ('default', ?, '2025-01-01')", [orphanProfile]);
  db.run("INSERT INTO shift_assignments (staff_id, work_date, note) VALUES (?, '2026-08-12', '旧排班')", [legacyProfile]);
  db.run("INSERT INTO shift_assignments (staff_id, work_date, note) VALUES (?, '2025-01-01', '历史排班')", [legacyProfile]);
  db.run("INSERT INTO attendance_records (staff_id, work_date, status) VALUES (?, '2026-08-12', 'normal')", [legacyProfile]);
  db.run("INSERT INTO staff_status (name, status) VALUES ('历史人员', 'on')");
  db.run(`INSERT INTO tickets
    (id, desc, created, worker, assignee_user_id, performance_rule_version_id)
    VALUES ('REAL-HISTORY-001', '历史工单', '2025-01-01T00:00:00.000Z', '历史人员', ?, NULL)`, [legacyUser]);
  db.run(`INSERT INTO ticket_activity_logs
    (ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)
    VALUES ('REAL-HISTORY-001', ?, ?, 'assign', '{}', '2025-01-01T01:00:00.000Z')`, [legacyUser, legacyProfile]);
  backfillTicketAssignees(db);
  backfillDefaultPerformanceRules(db);
  return db;
}

function options() {
  return {
    password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  };
}

test('固定清单只包含一个主管、三个师傅和一个管家', () => {
  const { RETAINED_ACCOUNTS } = require('../services/retained-test-data');
  assert.deepEqual(RETAINED_ACCOUNTS.map(({ phone, role }) => [phone, role]), [
    ['13800000001', '主管'],
    ['13800000002', 'worker'],
    ['13800000003', 'worker'],
    ['13800000004', 'worker'],
    ['13800000006', 'keeper'],
  ]);
});

test('预演摘要不包含密码、哈希或令牌', () => {
  const { planRetainedTestData } = require('../services/retained-test-data');
  const result = planRetainedTestData(createFixture(), options());
  assert.equal(result.summary.retainedAccounts, 5);
  assert.equal(result.summary.disabledAccounts, 3);
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
    ['13800000006', 'keeper', 'active'],
  ]);
  assert.equal(one(db, "SELECT status FROM users WHERE phone = '13900000000'").status, 'disabled');
  assert.equal(one(db, "SELECT employment_status FROM staff_profiles WHERE name = '无账号旧档案'").employment_status, 'inactive');
  assert.equal(Number(one(db, `SELECT COUNT(*) AS total FROM community_memberships cm
    JOIN staff_profiles sp ON sp.id = cm.staff_profile_id WHERE sp.name = '无账号旧档案'`).total), 0);
  assert.equal(rows(db, "SELECT id FROM shift_assignments WHERE note = '旧排班'").length, 0);
  assert.equal(rows(db, "SELECT id FROM shift_assignments WHERE note = '历史排班'").length, 1);
  assert.equal(rows(db, "SELECT id FROM attendance_records WHERE status = 'normal'").length, 0);
  assert.equal(rows(db, "SELECT name FROM staff_status WHERE name = '历史人员'").length, 0);
  const migratedHistory = one(db, "SELECT * FROM tickets WHERE id = 'REAL-HISTORY-001'");
  assert.equal(migratedHistory.assignee_staff_profile_id, 1);
  assert.deepEqual({ ...migratedHistory, assignee_staff_profile_id: null },
    { ...historyBefore, assignee_staff_profile_id: null });
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
  assert.equal(profiles.length, 5);
  assert.equal(profiles[0].manager_phone, null);
  assert.ok(profiles.slice(1).every(profile => profile.manager_phone === '13800000001'));
  assert.ok(profiles.every(profile => profile.employment_status === 'active'));
});

test('即使没有额外账号也会停用无账号旧档案', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  db.run("DELETE FROM users WHERE phone = '13900000000'");
  migrateRetainedTestData(db, options());
  assert.equal(one(db,
    "SELECT employment_status FROM staff_profiles WHERE name = '无账号旧档案'"
  ).employment_status, 'inactive');
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

test('被分配到模拟小区的人员都具有该小区成员权限', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const missing = rows(db, `SELECT DISTINCT u.phone FROM tickets t
    JOIN users u ON u.id = t.assignee_user_id
    JOIN staff_profiles sp ON sp.user_id = u.id
    LEFT JOIN community_memberships cm
      ON cm.staff_profile_id = sp.id AND cm.community_id = t.community_id
    WHERE t.id LIKE 'MOCK-E2E-%' AND t.assignee_user_id IS NOT NULL
      AND cm.staff_profile_id IS NULL`);
  assert.deepEqual(missing, []);
});

test('模拟排班覆盖白班、跨夜班、请假且不生成考勤', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  assert.equal(Number(one(db,
    "SELECT COUNT(*) AS total FROM shift_templates WHERE name IN ('模拟白班', '模拟夜班')"
  ).total), 2);
  assert.ok(Number(one(db,
    "SELECT COUNT(*) AS total FROM shift_assignments WHERE note LIKE 'MOCK-E2E%'"
  ).total) >= 12);
  assert.ok(Number(one(db,
    "SELECT COUNT(*) AS total FROM shift_assignments WHERE note LIKE 'MOCK-E2E%' AND assignment_type = 'leave'"
  ).total) >= 1);
  const overnight = one(db,
    "SELECT start_at, end_at FROM shift_assignments WHERE note = 'MOCK-E2E-OVERNIGHT'"
  );
  assert.ok(Date.parse(overnight.end_at) > Date.parse(overnight.start_at));
  assert.equal(Number(one(db, 'SELECT COUNT(*) AS total FROM attendance_records').total), 0);
});

test('重复迁移也会清空保留人员残留的全部历史考勤和变更日志', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const profile = one(db, "SELECT id FROM staff_profiles WHERE phone = '13800000002'");
  db.run("INSERT INTO attendance_records (staff_id, work_date, status) VALUES (?, '2026-08-01', 'late')", [profile.id]);
  const attendance = one(db, 'SELECT id FROM attendance_records WHERE staff_id = ?', [profile.id]);
  db.run("INSERT INTO attendance_change_logs (attendance_id, reason) VALUES (?, '历史补卡')", [attendance.id]);
  migrateRetainedTestData(db, options());
  assert.equal(Number(one(db, 'SELECT COUNT(*) AS total FROM attendance_records').total), 0);
  assert.equal(Number(one(db, 'SELECT COUNT(*) AS total FROM attendance_change_logs').total), 0);
});

test('每名普通测试人员均有完整已完成样本和当前工单', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const perPerson = rows(db, `SELECT u.phone,
    SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN t.status <> 'done' THEN 1 ELSE 0 END) AS current_count
    FROM users u JOIN tickets t ON t.assignee_user_id = u.id
    WHERE u.phone IN ('13800000002', '13800000003', '13800000004', '13800000006')
      AND t.id LIKE 'MOCK-E2E-%'
    GROUP BY u.phone ORDER BY u.phone`);
  assert.equal(perPerson.length, 4);
  assert.ok(perPerson.every(row => Number(row.completed) >= 5 && Number(row.current_count) >= 1));
});

test('每名维修师傅和管家都具备报修、投诉、帮助三类本人模拟工单', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const coverage = rows(db, `SELECT u.phone, t.type, COUNT(*) AS total
    FROM users u JOIN tickets t ON t.assignee_user_id = u.id
    WHERE u.phone IN ('13800000002', '13800000003', '13800000004', '13800000006')
      AND t.id LIKE 'MOCK-E2E-%'
    GROUP BY u.phone, t.type ORDER BY u.phone, t.type`);
  for (const phone of ['13800000002', '13800000003', '13800000004', '13800000006']) {
    assert.deepEqual(coverage.filter(row => row.phone === phone).map(row => row.type).sort(),
      ['complaint', 'help', 'repair']);
  }
});

test('模拟工单覆盖状态、复发、多人反馈、紧急、多小区和活动日志', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const tickets = rows(db, "SELECT * FROM tickets WHERE id LIKE 'MOCK-E2E-%'");
  assert.deepEqual([...new Set(tickets.map(row => row.status))].sort(),
    ['confirm', 'doing', 'done', 'pending', 'wait']);
  assert.ok(tickets.some(row => row.priority === 'urgent'));
  assert.ok(tickets.some(row => Number(row.is_recurring) === 1));
  assert.ok(tickets.some(row => Number(row.feedback_count) > 1));
  assert.ok(tickets.some(row => row.community_id === 'mock-e2e-community'));
  assert.ok(tickets.filter(row => row.assignee_user_id != null)
    .every(row => row.performance_rule_version_id != null));
  assert.ok(Number(one(db,
    "SELECT COUNT(*) AS total FROM ticket_activity_logs WHERE ticket_id LIKE 'MOCK-E2E-%'"
  ).total) >= 60);
  assert.ok(Number(one(db,
    "SELECT COUNT(*) AS total FROM ticket_activity_logs logs "
      + "JOIN users u ON u.id = logs.actor_user_id "
      + "WHERE logs.ticket_id LIKE 'MOCK-E2E-%' AND u.role = 'keeper' "
      + "AND logs.action IN ('approve_complete', 'reject')"
  ).total) >= 2);
});

test('主管日历能识别同人重叠工单并展示请假日工单', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const { buildDayCalendar } = require('../services/calendar');
  const db = createFixture();
  migrateRetainedTestData(db, options());
  const zhang = one(db, "SELECT id FROM staff_profiles WHERE phone = '13800000002'");
  const li = one(db, "SELECT id FROM staff_profiles WHERE phone = '13800000003'");
  const zhangCalendar = buildDayCalendar(db, {
    date: '2026-08-12', staffId: zhang.id, communityId: 'mock-e2e-community', viewerUserId: 1,
  });
  assert.ok(zhangCalendar.conflicts.length >= 1);
  assert.ok(zhangCalendar.conflicts.some(conflict => conflict.ticketIds
    .includes('MOCK-E2E-02-CONFLICT')));
  const liCalendar = buildDayCalendar(db, {
    date: '2026-08-12', staffId: li.id, communityId: 'default', viewerUserId: 1,
  });
  assert.equal(liCalendar.people[0].shift.assignmentType, 'leave');
  assert.ok(liCalendar.events.some(event => event.ticketId === 'MOCK-E2E-03-CURRENT'));
});

test('完整模拟数据重复迁移后记录数稳定且非 MOCK 历史不变', () => {
  const { migrateRetainedTestData } = require('../services/retained-test-data');
  const db = createFixture();
  const history = one(db, "SELECT * FROM tickets WHERE id = 'REAL-HISTORY-001'");
  migrateRetainedTestData(db, options());
  const first = rows(db, `SELECT
    (SELECT COUNT(*) FROM shift_assignments WHERE note LIKE 'MOCK-E2E%') AS shifts,
    (SELECT COUNT(*) FROM tickets WHERE id LIKE 'MOCK-E2E-%') AS tickets,
    (SELECT COUNT(*) FROM ticket_activity_logs WHERE ticket_id LIKE 'MOCK-E2E-%') AS activities`)[0];
  migrateRetainedTestData(db, options());
  const second = rows(db, `SELECT
    (SELECT COUNT(*) FROM shift_assignments WHERE note LIKE 'MOCK-E2E%') AS shifts,
    (SELECT COUNT(*) FROM tickets WHERE id LIKE 'MOCK-E2E-%') AS tickets,
    (SELECT COUNT(*) FROM ticket_activity_logs WHERE ticket_id LIKE 'MOCK-E2E-%') AS activities`)[0];
  assert.deepEqual(second, first);
  const migratedHistory = one(db, "SELECT * FROM tickets WHERE id = 'REAL-HISTORY-001'");
  assert.equal(migratedHistory.assignee_staff_profile_id, 1);
  assert.deepEqual({ ...migratedHistory, assignee_staff_profile_id: null },
    { ...history, assignee_staff_profile_id: null });
});
