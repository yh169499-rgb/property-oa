const assert = require('node:assert/strict');
const test = require('node:test');
const database = require('../db');
const { ensureWorkforceSchema, backfillCommunityMemberships } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const {
  createTestDB,
  tableNames,
  columnNames,
  indexNames,
} = require('./helpers/test-db');

test('workforce schema is idempotent and adds required tables', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());

  ensureWorkforceSchema(db);
  ensureWorkforceSchema(db);

  const names = tableNames(db);
  for (const name of [
    'staff_profiles',
    'shift_templates',
    'shift_assignments',
    'attendance_records',
    'attendance_change_logs',
    'ticket_activity_logs',
    'workforce_import_batches',
    'performance_rule_versions',
    'community_memberships',
    'ai_report_analyses',
  ]) {
    assert.equal(names.includes(name), true, `missing table: ${name}`);
  }

  const ticketColumns = columnNames(db, 'tickets');
  assert.equal(ticketColumns.includes('assignee_user_id'), true);
  assert.equal(ticketColumns.includes('assigned_at'), true);
  assert.equal(ticketColumns.includes('performance_rule_version_id'), true);

  const aiColumns = columnNames(db, 'ai_report_analyses');
  for (const column of [
    'staff_profile_id', 'community_id', 'range_from', 'range_to',
    'report_hash', 'model', 'prompt_version', 'analysis_json',
    'created_by_user_id', 'created_at',
  ]) {
    assert.equal(aiColumns.includes(column), true, `missing AI cache column: ${column}`);
  }
  assert.equal(indexNames(db).includes('uq_ai_report_cache'), true);
});

test('workforce schema keeps departed identity and stable ticket assignee', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  db.run("ALTER TABLE tickets ADD COLUMN created TEXT DEFAULT ''");

  ensureWorkforceSchema(db);
  ensureWorkforceSchema(db);

  const profileColumns = columnNames(db, 'staff_profiles');
  assert.equal(profileColumns.includes('departed_at'), true);
  assert.equal(profileColumns.includes('departed_by_user_id'), true);
  assert.equal(columnNames(db, 'tickets').includes('assignee_staff_profile_id'), true);
  assert.equal(indexNames(db).includes('idx_tickets_assignee_profile'), true);

  const indexColumns = db.exec('PRAGMA index_info(idx_tickets_assignee_profile)');
  assert.deepEqual(
    indexColumns[0].values.map((row) => row[2]),
    ['assignee_staff_profile_id', 'created']
  );
});

test('ticket assignee profile index upgrades when created becomes available', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());

  ensureWorkforceSchema(db);
  assert.deepEqual(
    db.exec('PRAGMA index_info(idx_tickets_assignee_profile)')[0].values.map((row) => row[2]),
    ['assignee_staff_profile_id']
  );

  db.run("ALTER TABLE tickets ADD COLUMN created TEXT DEFAULT ''");
  ensureWorkforceSchema(db);

  assert.deepEqual(
    db.exec('PRAGMA index_info(idx_tickets_assignee_profile)')[0].values.map((row) => row[2]),
    ['assignee_staff_profile_id', 'created']
  );
});

test('ticket assignee profile backfill uses user identity and never guesses by name', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  db.run("ALTER TABLE tickets ADD COLUMN created TEXT DEFAULT ''");

  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800001001', 'hash', '身份匹配人员', 'worker'),
      (2, '13800001002', 'hash', '无档案人员', 'worker')
  `);
  db.run(`
    INSERT INTO staff_profiles (id, user_id, name) VALUES
      (11, 1, '身份匹配人员'),
      (12, NULL, '仅同名人员')
  `);
  db.run(`
    INSERT INTO tickets (id, worker, assignee_user_id, created) VALUES
      ('by-user-id', '名字不同也应匹配', 1, '2026-08-12T00:00:00Z'),
      ('same-name-only', '仅同名人员', NULL, '2026-08-12T00:00:00Z'),
      ('missing-profile', '无档案人员', 2, '2026-08-12T00:00:00Z')
  `);

  ensureWorkforceSchema(db);

  assert.deepEqual(
    db.exec('SELECT id, assignee_staff_profile_id FROM tickets ORDER BY id')[0].values,
    [
      ['by-user-id', 11],
      ['missing-profile', null],
      ['same-name-only', null],
    ]
  );
});

test('performance rules include a stable default version 1', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  ensureWorkforceSchema(db);

  const rows = db.exec(`
    SELECT version_no, completion_weight, on_time_weight, quality_weight,
      excellent_threshold, good_threshold, qualified_threshold,
      minimum_sample_size, is_active
    FROM performance_rule_versions
    WHERE version_no = 1
  `);
  assert.equal(rows[0].values.length, 1);
  assert.deepEqual(rows[0].values[0], [1, 30, 50, 20, 90, 80, 60, 1, 1]);

  ensureWorkforceSchema(db);
  assert.equal(db.exec('SELECT COUNT(*) FROM performance_rule_versions')[0].values[0][0], 1);
});

test('old community permissions migrate only uniquely named staff profiles', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  db.run(`
    CREATE TABLE communities (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE community_permissions (
      community_id TEXT NOT NULL,
      staff_name TEXT NOT NULL,
      PRIMARY KEY (community_id, staff_name)
    );
  `);
  db.run("INSERT INTO community_permissions VALUES ('c1', '张三')");
  db.run("INSERT INTO community_permissions VALUES ('c1', '李四')");
  db.run("INSERT INTO community_permissions VALUES ('c1', '王五')");

  ensureWorkforceSchema(db);
  db.run("INSERT INTO staff_profiles (name) VALUES ('张三')");
  db.run("INSERT INTO staff_profiles (name) VALUES ('李四')");
  db.run("INSERT INTO staff_profiles (name) VALUES ('李四')");
  ensureWorkforceSchema(db);
  ensureWorkforceSchema(db);

  const rows = db.exec(`
    SELECT community_id, staff_profile_id
    FROM community_memberships
    ORDER BY staff_profile_id
  `);
  assert.deepEqual(rows[0].values, [['c1', 1]]);
});

test('single community without legacy permissions enrolls active profiles only', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  db.run(`
    CREATE TABLE communities (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
    INSERT INTO communities (id, name, created) VALUES ('default', '默认小区', '2026-01-01T00:00:00Z');
  `);
  ensureWorkforceSchema(db);
  db.run("INSERT INTO staff_profiles (id, name, employment_status) VALUES (1, '在岗师傅', 'active'), (2, '已停用师傅', 'inactive')");
  backfillCommunityMemberships(db);
  assert.deepEqual(db.exec('SELECT community_id, staff_profile_id FROM community_memberships ORDER BY staff_profile_id')[0].values, [['default', 1]]);
});

test('workforce tables expose the approved fields and indexes', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  ensureWorkforceSchema(db);

  const expectedColumns = {
    staff_profiles: [
      'id', 'tenant_id', 'user_id', 'name', 'birth_month', 'join_date', 'phone',
      'position', 'skill', 'manager_id', 'employment_status', 'departed_at',
      'departed_by_user_id', 'created_at', 'updated_at',
    ],
    shift_templates: [
      'id', 'tenant_id', 'name', 'start_time', 'end_time', 'color', 'grace_minutes',
      'created_by',
    ],
    shift_assignments: [
      'id', 'tenant_id', 'staff_id', 'work_date', 'assignment_type', 'template_id',
      'start_at', 'end_at', 'leave_type', 'note', 'created_by', 'updated_at',
    ],
    attendance_records: [
      'id', 'tenant_id', 'staff_id', 'shift_assignment_id', 'work_date', 'check_in_at',
      'check_out_at', 'status', 'is_corrected', 'updated_at',
    ],
    attendance_change_logs: [
      'id', 'tenant_id', 'attendance_id', 'operator_user_id', 'before_json', 'after_json',
      'reason', 'created_at',
    ],
    ticket_activity_logs: [
      'id', 'tenant_id', 'ticket_id', 'actor_user_id', 'actor_staff_id', 'action',
      'metadata', 'created_at',
    ],
  };

  for (const [table, expected] of Object.entries(expectedColumns)) {
    assert.deepEqual(columnNames(db, table), expected, table);
  }

  const indexes = indexNames(db);
  for (const name of [
    'idx_staff_manager',
    'idx_shift_staff_date',
    'idx_attendance_staff_date',
    'idx_ticket_activity_actor_time',
  ]) {
    assert.equal(indexes.includes(name), true, `missing index: ${name}`);
  }

  const membershipIndexes = db.exec(`PRAGMA index_list(community_memberships)`)[0].values;
  const uniqueMembership = membershipIndexes.find((row) => row[2] === 1);
  assert.ok(uniqueMembership, 'community memberships should have a unique index');
  const membershipIndexColumns = db.exec(`PRAGMA index_info(${JSON.stringify(uniqueMembership[1])})`);
  assert.deepEqual(membershipIndexColumns[0].values.map((row) => row[2]), ['tenant_id', 'community_id', 'staff_profile_id']);
});

test('daily shift assignments and attendance records are unique per staff member', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  ensureWorkforceSchema(db);

  db.run("INSERT INTO shift_assignments (staff_id, work_date) VALUES (1, '2026-07-30')");
  assert.throws(
    () => db.run("INSERT INTO shift_assignments (staff_id, work_date) VALUES (1, '2026-07-30')"),
    /UNIQUE constraint failed/
  );

  db.run("INSERT INTO attendance_records (staff_id, work_date) VALUES (1, '2026-07-30')");
  assert.throws(
    () => db.run("INSERT INTO attendance_records (staff_id, work_date) VALUES (1, '2026-07-30')"),
    /UNIQUE constraint failed/
  );
});

test('test database injection disables persistence without exporting the test database', (t) => {
  const original = database.getDB();
  let exportCalls = 0;
  const testDb = {
    export() {
      exportCalls += 1;
      throw new Error('test database must not be exported');
    },
  };
  const restore = database.setDBForTests(testDb);
  t.after(() => {
    if (typeof restore === 'function') restore();
    else database.setDBForTests(original);
  });

  assert.doesNotThrow(() => database.saveDB());
  assert.equal(exportCalls, 0);
});

test('test database restore is idempotent and restores the original reference', (t) => {
  const original = database.getDB();
  const testDb = { name: 'isolated test database' };
  const restore = database.setDBForTests(testDb);
  t.after(() => {
    if (database.getDB() === testDb) {
      if (typeof restore === 'function') restore();
      else database.setDBForTests(original);
    }
  });

  assert.equal(typeof restore, 'function');
  assert.equal(database.getDB(), testDb);
  restore();
  restore();
  assert.equal(database.getDB(), original);
});

test('closing a test HTTP server restores the previous database reference', async (t) => {
  const original = database.getDB();
  const previous = { name: 'previous database' };
  const restorePrevious = database.setDBForTests(previous);
  t.after(() => {
    if (typeof restorePrevious === 'function') restorePrevious();
    else database.setDBForTests(original);
  });

  const testDb = { name: 'HTTP test database' };
  const server = await startHttpServer(testDb);
  let closed = false;
  t.after(async () => {
    if (!closed) await server.close();
  });

  assert.equal(database.getDB(), testDb);
  await server.close();
  closed = true;
  assert.equal(database.getDB(), previous);

  await server.close();
  assert.equal(database.getDB(), previous);
});
