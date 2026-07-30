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
      (5, '5', 'x', '外部员工', 'worker'),
      (6, '6', 'x', '停用员工', 'worker')
  `);
  db.run(`
    INSERT INTO staff_profiles (id, user_id, name, manager_id, employment_status) VALUES
      (10, 2, '主管', NULL, 'active'),
      (11, 3, '员工甲', 10, 'active'),
      (12, 4, '员工乙', 11, 'active'),
      (13, 5, '外部员工', NULL, 'active'),
      (14, 6, '停用员工', 10, 'inactive')
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
       'doing', '2026-07-30T08:30:00+08:00', 1, 'c2'),
      ('UTC-IN', '员工甲', 3, '2026-07-29T16:30:00.000Z', '跨日', '上海',
       'doing', '2026-07-29T16:00:00.000Z', 1, 'utc'),
      ('UTC-OUT', '员工甲', 3, '2026-07-30T16:00:00.000Z', '跨日', '上海',
       'doing', '2026-07-30T15:30:00.000Z', 1, 'utc'),
      ('INACTIVE', '停用员工', 6, '2026-07-30T09:00:00+08:00', '其他', '停用',
       'doing', '2026-07-30T08:30:00+08:00', 1, 'c1')
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

test('uses Asia/Shanghai absolute day boundaries for UTC ticket timestamps', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', staffId: 11, communityId: 'utc', viewerUserId: 1,
  });
  assert.deepEqual(result.events.map((event) => event.ticketId), ['UTC-IN']);
});

test('hides inactive profiles by default and for explicit or self selection', async (t) => {
  const db = await fixture();
  const { buildDayCalendar } = require('../services/calendar');
  assert.equal(buildDayCalendar(db, {
    date: '2026-07-30', viewerUserId: 1,
  }).people.some((person) => person.id === 14), false);
  assert.deepEqual(buildDayCalendar(db, {
    date: '2026-07-30', staffId: 14, viewerUserId: 1,
  }).people, []);

  const server = await startHttpServer(db);
  t.after(() => server.close());
  const response = await fetch(
    `${server.url}/api/calendar/day?date=2026-07-30`,
    { headers: authHeader({ id: 6, role: 'worker' }) }
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).people, []);
});

test('loads completed ticket history in one batch instead of per person', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const originalPrepare = db.prepare.bind(db);
  let historyQueries = 0;
  db.prepare = (sql) => {
    if (/finished <>/.test(sql)) historyQueries += 1;
    return originalPrepare(sql);
  };
  const { buildDayCalendar } = require('../services/calendar');
  buildDayCalendar(db, { date: '2026-07-30', viewerUserId: 1 });
  assert.equal(historyQueries, 1);
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
  assert.deepEqual(body.events.map((event) => event.ticketId), ['UTC-IN', 'WX1001', 'WX1002']);
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

test('calendar endpoint hides unexpected database errors', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  db.prepare = () => {
    const error = new Error('SQL secret: no such column');
    error.status = 400;
    error.code = 'SQLITE_FAILURE';
    throw error;
  };
  const response = await fetch(
    `${server.url}/api/calendar/day?date=2026-07-30`,
    { headers: authHeader({ id: 1, role: 'admin' }) }
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: '内部服务器错误',
    code: 'INTERNAL_ERROR',
  });
});
