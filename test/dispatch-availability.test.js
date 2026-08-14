const assert = require('node:assert/strict');
const test = require('node:test');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');

async function fixture() {
  const db = await createTestDB();
  for (const definition of [
    "status TEXT DEFAULT 'wait'",
    "created TEXT DEFAULT ''",
    'estimated_hours REAL DEFAULT 0',
  ]) db.run(`ALTER TABLE tickets ADD COLUMN ${definition}`);
  ensureWorkforceSchema(db);
  db.run("INSERT INTO users (id, phone, password, name, role) VALUES (1, '1', 'x', '张师傅', 'worker')");
  db.run("INSERT INTO staff_profiles (id, user_id, name) VALUES (2, 1, '张师傅')");
  return db;
}

function addShift(db, type, options = {}) {
  db.run(`INSERT INTO shift_assignments
    (staff_id, work_date, assignment_type, start_at, end_at, leave_type)
    VALUES (2, ?, ?, ?, ?, ?)`, [
    options.workDate || '2026-08-13', type,
    options.startAt === undefined ? '2026-08-13T08:00:00+08:00' : options.startAt,
    options.endAt === undefined ? '2026-08-13T18:00:00+08:00' : options.endAt,
    options.leaveType || null,
  ]);
}

function expectUnavailable(fn, code, ticketIds = []) {
  assert.throws(fn, error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, code);
    assert.deepEqual(error.conflictingTicketIds || [], ticketIds);
    return true;
  });
}

test('allows dispatch fully contained in a work shift', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  addShift(db, 'work');
  const { assertDispatchAvailable } = require('../services/dispatch-availability');
  const result = assertDispatchAvailable(db, {
    staffProfileId: 2,
    assignedAt: '2026-08-13T09:00:00+08:00',
    estimatedHours: 2,
  });
  assert.equal(result.shift.id > 0, true);
  assert.equal(result.startAt, '2026-08-13T01:00:00.000Z');
  assert.equal(result.endAt, '2026-08-13T03:00:00.000Z');
});

test('rejects unscheduled, rest and leave days with stable codes', async (t) => {
  const { assertDispatchAvailable } = require('../services/dispatch-availability');
  const cases = [
    { type: null, code: 'ASSIGNEE_NOT_SCHEDULED' },
    { type: 'rest', code: 'ASSIGNEE_RESTING' },
    { type: 'leave', code: 'ASSIGNEE_ON_LEAVE' },
  ];
  for (const entry of cases) {
    const db = await fixture();
    t.after(() => db.close());
    if (entry.type) addShift(db, entry.type, {
      startAt: null,
      endAt: null,
      leaveType: entry.type === 'leave' ? '事假' : null,
    });
    expectUnavailable(() => assertDispatchAvailable(db, {
      staffProfileId: 2,
      assignedAt: '2026-08-13T09:00:00+08:00',
      estimatedHours: 1,
    }), entry.code);
  }
});

test('rejects dispatch before shift, at shift end and ending after shift', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  addShift(db, 'work');
  const { assertDispatchAvailable } = require('../services/dispatch-availability');
  for (const value of [
    { assignedAt: '2026-08-13T07:59:00+08:00', estimatedHours: 1 },
    { assignedAt: '2026-08-13T18:00:00+08:00', estimatedHours: 1 },
    { assignedAt: '2026-08-13T17:00:00+08:00', estimatedHours: 2 },
  ]) {
    expectUnavailable(() => assertDispatchAvailable(db, {
      staffProfileId: 2,
      ...value,
    }), 'ASSIGNMENT_OUTSIDE_SHIFT');
  }
});

test('accepts dispatch during an overnight shift', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  addShift(db, 'work', {
    workDate: '2026-08-13',
    startAt: '2026-08-13T22:00:00+08:00',
    endAt: '2026-08-14T06:00:00+08:00',
  });
  const { assertDispatchAvailable } = require('../services/dispatch-availability');
  const result = assertDispatchAvailable(db, {
    staffProfileId: 2,
    assignedAt: '2026-08-14T01:00:00+08:00',
    estimatedHours: 2,
  });
  assert.equal(result.endAt, '2026-08-13T19:00:00.000Z');
});

test('current-day leave or rest overrides a previous overnight shift', async (t) => {
  const { assertDispatchAvailable } = require('../services/dispatch-availability');
  for (const [type, code] of [['leave', 'ASSIGNEE_ON_LEAVE'], ['rest', 'ASSIGNEE_RESTING']]) {
    const db = await fixture();
    t.after(() => db.close());
    addShift(db, 'work', {
      workDate: '2026-08-13',
      startAt: '2026-08-13T22:00:00+08:00',
      endAt: '2026-08-14T06:00:00+08:00',
    });
    addShift(db, type, {
      workDate: '2026-08-14', startAt: null, endAt: null,
      leaveType: type === 'leave' ? '事假' : null,
    });
    expectUnavailable(() => assertDispatchAvailable(db, {
      staffProfileId: 2,
      assignedAt: '2026-08-14T01:00:00+08:00',
      estimatedHours: 1,
    }), code);
  }
});

test('rejects overlap with unfinished tickets and can exclude the edited ticket', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  addShift(db, 'work');
  db.run(`INSERT INTO tickets
    (id, worker, status, created, estimated_hours, assignee_user_id,
     assignee_staff_profile_id, assigned_at)
    VALUES ('EXISTING', '张师傅', 'doing', '2026-08-13T09:00:00+08:00', 2, 1, 2,
      '2026-08-13T09:00:00+08:00')`);
  const { assertDispatchAvailable } = require('../services/dispatch-availability');
  expectUnavailable(() => assertDispatchAvailable(db, {
    staffProfileId: 2,
    assignedAt: '2026-08-13T10:00:00+08:00',
    estimatedHours: 1,
  }), 'ASSIGNMENT_TIME_CONFLICT', ['EXISTING']);

  assert.doesNotThrow(() => assertDispatchAvailable(db, {
    staffProfileId: 2,
    assignedAt: '2026-08-13T10:00:00+08:00',
    estimatedHours: 1,
    excludeTicketId: 'EXISTING',
  }));
});

test('completed tickets and another employee do not block dispatch', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  addShift(db, 'work');
  db.run(`INSERT INTO tickets
    (id, worker, status, created, estimated_hours, assignee_staff_profile_id, assigned_at)
    VALUES
      ('DONE', '张师傅', 'done', '2026-08-13T09:00:00+08:00', 2, 2, '2026-08-13T09:00:00+08:00'),
      ('OTHER', '李师傅', 'doing', '2026-08-13T09:00:00+08:00', 2, 3, '2026-08-13T09:00:00+08:00')`);
  const { assertDispatchAvailable } = require('../services/dispatch-availability');
  assert.doesNotThrow(() => assertDispatchAvailable(db, {
    staffProfileId: 2,
    assignedAt: '2026-08-13T10:00:00+08:00',
    estimatedHours: 1,
  }));
});
