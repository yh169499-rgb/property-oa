const assert = require('node:assert/strict');
const test = require('node:test');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function fixture() {
  const db = await createTestDB();
  for (const definition of [
    "type TEXT DEFAULT 'repair'",
    "cat TEXT DEFAULT ''",
    "desc TEXT DEFAULT ''",
    "loc TEXT DEFAULT ''",
    "status TEXT DEFAULT 'wait'",
    "created TEXT DEFAULT ''",
    "finished TEXT DEFAULT ''",
    'estimated_hours REAL DEFAULT 0',
    "community_id TEXT DEFAULT 'default'",
  ]) {
    db.run(`ALTER TABLE tickets ADD COLUMN ${definition}`);
  }
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '1', 'x', '管理员', 'admin'),
      (2, '2', 'x', '主管', 'lead'),
      (3, '3', 'x', '员工甲', 'worker'),
      (4, '4', 'x', '员工乙', 'worker'),
      (5, '5', 'x', '外部员工', 'worker')
  `);
  db.run(`
    INSERT INTO staff_profiles (id, user_id, name, manager_id) VALUES
      (10, 2, '主管', NULL),
      (11, 3, '员工甲', 10),
      (12, 4, '员工乙', 11),
      (13, 5, '外部员工', NULL)
  `);
  db.run(`
    INSERT INTO shift_assignments
      (id, staff_id, work_date, assignment_type, start_at, end_at, leave_type)
    VALUES
      (20, 11, '2026-07-30', 'work',
       '2026-07-30T08:00:00+08:00', '2026-07-30T18:00:00+08:00', NULL),
      (21, 12, '2026-07-30', 'leave', NULL, NULL, 'annual')
  `);
  db.run(`
    INSERT INTO attendance_records
      (staff_id, shift_assignment_id, work_date, check_in_at, status)
    VALUES (11, 20, '2026-07-30', '2026-07-30T07:58:00+08:00', 'normal')
  `);
  db.run(`
    INSERT INTO tickets
      (id, worker, assignee_user_id, assigned_at, cat, loc, status, created,
       estimated_hours, community_id)
    VALUES
      ('WX1001', '员工甲', 3, '2026-07-30T09:00:00+08:00', '水电', '1栋',
       'doing', '2026-07-30T08:30:00+08:00', 2, 'c1'),
      ('WX1002', '员工甲', 3, '2026-07-30T10:00:00+08:00', '门窗', '2栋',
       'doing', '2026-07-30T09:30:00+08:00', 1, 'c1'),
      ('WX1003', '员工乙', 4, '2026-07-30T14:00:00+08:00', '巡检', '3栋',
       'wait', '2026-07-30T13:30:00+08:00', 1, 'c1'),
      ('WX9999', '外部员工', 5, '2026-07-30T09:00:00+08:00', '其他', '外部',
       'doing', '2026-07-30T08:30:00+08:00', 1, 'c2')
  `);
  return db;
}

test('aggregates people, shifts, attendance, tickets and same-staff conflicts', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', managerId: 10, communityId: 'c1', viewerUserId: 2,
  });
  assert.equal(result.people.length, 2);
  assert.equal(result.people.find((person) => person.id === 11).shift.assignmentType, 'work');
  assert.equal(result.people.find((person) => person.id === 11).attendance.status, 'normal');
  assert.equal(result.people.find((person) => person.id === 12).shift.assignmentType, 'leave');
  assert.equal(result.events[0].ticketId, 'WX1001');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].staffId, 11);
  assert.deepEqual(result.conflicts[0].ticketIds, ['WX1001', 'WX1002']);
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('does not report overlaps belonging to different staff', () => {
  const { detectCalendarConflicts } = require('../services/calendar');
  assert.deepEqual(detectCalendarConflicts([
    { ticketId: 'A', staffId: 1, startAt: '2026-07-30T09:00:00+08:00', endAt: '2026-07-30T11:00:00+08:00' },
    { ticketId: 'B', staffId: 2, startAt: '2026-07-30T10:00:00+08:00', endAt: '2026-07-30T12:00:00+08:00' },
  ]), []);
});

test('ordinary user is forced to own staff profile despite requested filters', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const response = await fetch(
    `${server.url}/api/calendar/day?date=2026-07-30&staff_id=13&manager_id=10`,
    { headers: authHeader({ id: 3, role: 'worker' }) }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.people.map((person) => person.id), [11]);
  assert.deepEqual(body.events.map((event) => event.ticketId), ['WX1001', 'WX1002']);
});

test('lead may recursively filter own team but cannot inspect another tree', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const headers = authHeader({ id: 2, role: 'lead' });
  const team = await fetch(
    `${server.url}/api/calendar/day?date=2026-07-30&manager_id=11`,
    { headers }
  );
  assert.equal(team.status, 200);
  assert.deepEqual((await team.json()).people.map((person) => person.id), [12]);

  const forbidden = await fetch(
    `${server.url}/api/calendar/day?date=2026-07-30&staff_id=13`,
    { headers }
  );
  assert.equal(forbidden.status, 403);
});

test('calendar endpoint requires authentication and strictly validates date', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}/api/calendar/day?date=2026-07-30`)).status, 401);
  const response = await fetch(
    `${server.url}/api/calendar/day?date=2026-02-31`,
    { headers: authHeader({ id: 1, role: 'admin' }) }
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_DATE');
});
