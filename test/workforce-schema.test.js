const assert = require('node:assert/strict');
const test = require('node:test');
const database = require('../db');
const { ensureWorkforceSchema } = require('../workforce-schema');
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
  ]) {
    assert.equal(names.includes(name), true, `missing table: ${name}`);
  }

  const ticketColumns = columnNames(db, 'tickets');
  assert.equal(ticketColumns.includes('assignee_user_id'), true);
  assert.equal(ticketColumns.includes('assigned_at'), true);
});

test('workforce tables expose the approved fields and indexes', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  ensureWorkforceSchema(db);

  const expectedColumns = {
    staff_profiles: [
      'id', 'user_id', 'name', 'birth_month', 'join_date', 'phone',
      'position', 'skill', 'manager_id', 'employment_status', 'created_at',
      'updated_at',
    ],
    shift_templates: [
      'id', 'name', 'start_time', 'end_time', 'color', 'grace_minutes',
      'created_by',
    ],
    shift_assignments: [
      'id', 'staff_id', 'work_date', 'assignment_type', 'template_id',
      'start_at', 'end_at', 'leave_type', 'note', 'created_by', 'updated_at',
    ],
    attendance_records: [
      'id', 'staff_id', 'shift_assignment_id', 'work_date', 'check_in_at',
      'check_out_at', 'status', 'is_corrected', 'updated_at',
    ],
    attendance_change_logs: [
      'id', 'attendance_id', 'operator_user_id', 'before_json', 'after_json',
      'reason', 'created_at',
    ],
    ticket_activity_logs: [
      'id', 'ticket_id', 'actor_user_id', 'actor_staff_id', 'action',
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
