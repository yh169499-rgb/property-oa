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
      (6, '6', 'x', '停用员工', 'worker'),
      (7, '7', 'x', '重名员工', 'worker'),
      (8, '8', 'x', '重名员工', 'worker')
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
    INSERT INTO staff_profiles (id, user_id, name, manager_id, employment_status) VALUES
      (15, NULL, '旧员工', 10, 'active'),
      (16, 7, '重名员工', 10, 'active'),
      (17, 8, '重名员工', 10, 'active')
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
       'doing', '2026-07-30T08:30:00+08:00', 1, 'c1'),
      ('AVG-NOW', '员工甲', 3, '2026-07-30T09:00:00+08:00', '平均', '上海',
       'doing', '2026-07-30T08:30:00+08:00', 0, 'avg'),
      ('AVG-H1', '员工甲', 3, '2026-07-20T09:00:00+08:00', '历史', '上海',
       'done', '2026-07-20T08:30:00+08:00', 0, 'avg'),
      ('AVG-H2', '员工甲', 3, '2026-07-21T09:00:00+08:00', '历史', '上海',
       'done', '2026-07-21T08:30:00+08:00', 0, 'avg'),
      ('LEGACY-NOW', '旧员工', NULL, '2026-07-30T09:00:00+08:00', '旧工单', '上海',
       'doing', '2026-07-30T08:30:00+08:00', 0, 'legacy'),
      ('LEGACY-H1', '旧员工', NULL, '2026-07-20T09:00:00+08:00', '历史', '上海',
       'done', '2026-07-20T08:30:00+08:00', 0, 'legacy'),
      ('LEGACY-H2', '旧员工', NULL, '2026-07-21T09:00:00+08:00', '历史', '上海',
       'done', '2026-07-21T08:30:00+08:00', 0, 'legacy'),
      ('DUP-NOW', '重名员工', 7, '2026-07-30T10:00:00+08:00', '重名', '上海',
       'doing', '2026-07-30T09:30:00+08:00', 0, 'duplicate'),
      ('DUP-LEGACY-NOW', '重名员工', NULL, '2026-07-30T11:00:00+08:00', '重名', '上海',
       'doing', '2026-07-30T10:30:00+08:00', 0, 'duplicate'),
      ('DUP-H1', '重名员工', NULL, '2026-07-20T09:00:00+08:00', '历史', '上海',
       'done', '2026-07-20T08:30:00+08:00', 0, 'duplicate')
  `);
  db.run(`
    UPDATE tickets SET finished = '2026-07-20T11:00:00+08:00' WHERE id = 'AVG-H1';
    UPDATE tickets SET finished = '2026-07-21T13:00:00+08:00' WHERE id = 'AVG-H2';
    UPDATE tickets SET finished = '2026-07-20T11:00:00+08:00' WHERE id = 'LEGACY-H1';
    UPDATE tickets SET finished = '2026-07-21T13:00:00+08:00' WHERE id = 'LEGACY-H2';
    UPDATE tickets SET finished = '2026-07-20T15:00:00+08:00' WHERE id = 'DUP-H1'
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
  assert.equal(result.people.length, 5);
  assert.equal(result.people.find((person) => person.id === 11).shift.assignmentType, 'work');
  assert.equal(result.people.find((person) => person.id === 11).accountRole, 'worker');
  assert.equal(result.people.find((person) => person.id === 11).shift.templateName, '');
  assert.equal(result.people.find((person) => person.id === 11).attendance.status, 'normal');
  assert.equal(result.people.find((person) => person.id === 12).shift.assignmentType, 'leave');
  assert.equal(result.events[0].ticketId, 'WX1001');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].staffId, 11);
  assert.equal(result.conflicts[0].type, 'ticket_overlap');
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

test('treats a work shift as dispatch availability rather than a conflicting event', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  db.run("DELETE FROM tickets WHERE id = 'WX1002'");
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', staffId: 11, communityId: 'c1', viewerUserId: 1,
  });
  assert.equal(result.people[0].shift.startAt, '2026-07-30T08:00:00+08:00');
  assert.deepEqual(result.events.map(event => event.ticketId), ['WX1001']);
  assert.deepEqual(result.conflicts, []);
});

test('shows the carried-over portion of a previous overnight shift after midnight', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  db.run('DELETE FROM shift_assignments WHERE staff_id = 11 AND work_date = ?', ['2026-07-30']);
  db.run(`INSERT INTO shift_assignments
    (staff_id, work_date, assignment_type, start_at, end_at)
    VALUES (11, '2026-07-29', 'work',
      '2026-07-29T22:00:00+08:00', '2026-07-30T06:00:00+08:00')`);
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', staffId: 11, viewerUserId: 1,
  });
  assert.equal(result.people[0].shift.assignmentType, 'work');
  assert.equal(result.people[0].shift.startAt, '2026-07-29T16:00:00.000Z');
  assert.equal(result.people[0].shift.endAt, '2026-07-30T06:00:00+08:00');
  assert.equal(result.people[0].shift.carriedOver, true);
});

test('shows both carried-over overnight and current-day work windows', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  db.run("DELETE FROM shift_assignments WHERE staff_id = 11 AND work_date = '2026-07-30'");
  db.run(`INSERT INTO shift_assignments
    (staff_id, work_date, assignment_type, start_at, end_at)
    VALUES
      (11, '2026-07-29', 'work', '2026-07-29T22:00:00+08:00', '2026-07-30T06:00:00+08:00'),
      (11, '2026-07-30', 'work', '2026-07-30T22:00:00+08:00', '2026-07-31T06:00:00+08:00')`);
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', staffId: 11, viewerUserId: 1,
  });
  assert.deepEqual(result.people[0].shifts.map(shift => ({
    startAt: shift.startAt, endAt: shift.endAt, carriedOver: shift.carriedOver,
  })), [
    { startAt: '2026-07-29T16:00:00.000Z', endAt: '2026-07-30T06:00:00+08:00', carriedOver: true },
    { startAt: '2026-07-30T22:00:00+08:00', endAt: '2026-07-31T06:00:00+08:00', carriedOver: false },
  ]);
});

test('shows and clips tickets that started before midnight but overlap the selected day', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  db.run(`INSERT INTO tickets
    (id, worker, assignee_user_id, assigned_at, cat, loc, status, created,
     estimated_hours, community_id)
    VALUES ('OVERNIGHT-TICKET', '员工甲', 3, '2026-07-29T23:00:00+08:00',
      '跨夜维修', '机房', 'doing', '2026-07-29T22:50:00+08:00', 3, 'c1')`);
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', staffId: 11, communityId: 'c1', viewerUserId: 1,
  });
  const event = result.events.find(item => item.ticketId === 'OVERNIGHT-TICKET');
  assert.equal(event.startAt, '2026-07-29T16:00:00.000Z');
  assert.equal(event.endAt, '2026-07-29T18:00:00.000Z');
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

test('aggregates completed history in SQL without loading individual rows', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const originalPrepare = db.prepare.bind(db);
  const historySql = [];
  db.prepare = (sql) => {
    if (/finished <>/.test(sql)) historySql.push(sql);
    return originalPrepare(sql);
  };
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', staffId: 11, communityId: 'avg', viewerUserId: 1,
  });
  assert.equal(historySql.length, 1);
  assert.match(historySql[0], /AVG\s*\(/i);
  assert.match(historySql[0], /GROUP BY\s+assignee_user_id/i);
  assert.match(historySql[0], /UNION ALL/i);
  assert.doesNotMatch(historySql[0], /SELECT\s+worker/i);
  assert.equal(result.events[0].estimatedHours, 3);
});

test('uses legacy name average only for a uniquely named profile', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', managerId: 10, communityId: 'legacy', viewerUserId: 1,
  });
  assert.equal(result.events[0].ticketId, 'LEGACY-NOW');
  assert.equal(result.events[0].staffId, 15);
  assert.equal(result.events[0].estimatedHours, 3);
});

test('does not apply legacy name history or current tickets to duplicate names', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const { buildDayCalendar } = require('../services/calendar');
  const result = buildDayCalendar(db, {
    date: '2026-07-30', managerId: 10, communityId: 'duplicate', viewerUserId: 1,
  });
  assert.deepEqual(result.events.map((event) => event.ticketId), ['DUP-NOW']);
  assert.equal(result.events[0].staffId, 16);
  assert.equal(result.events[0].estimatedHours, 1);
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
  assert.deepEqual(
    body.events.map((event) => event.ticketId),
    ['UTC-IN', 'AVG-NOW', 'WX1001', 'WX1002']
  );
  assert.equal(body.people[0].shift.templateName, '');
});

test('ordinary user calendar never falls back to worker name for unassigned tickets', async (t) => {
  const db = await fixture();
  db.run(`
    INSERT INTO tickets
      (id, worker, assignee_user_id, assigned_at, cat, status, created,
       estimated_hours, community_id)
    VALUES
      ('UNASSIGNED-UNIQUE', '员工甲', NULL, '2026-07-30T12:00:00+08:00', '未分配',
       'wait', '2026-07-30T11:30:00+08:00', 1, 'c1')
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());

  const uniqueName = await fetch(
    `${server.url}/api/calendar/day?date=2026-07-30`,
    { headers: authHeader({ id: 3, role: 'worker', name: '员工甲' }) }
  );
  assert.equal(uniqueName.status, 200);
  assert.equal(
    (await uniqueName.json()).events.some((event) => event.ticketId === 'UNASSIGNED-UNIQUE'),
    false
  );

  const duplicateName = await fetch(
    `${server.url}/api/calendar/day?date=2026-07-30&community_id=duplicate`,
    { headers: authHeader({ id: 7, role: 'worker', name: '重名员工' }) }
  );
  assert.equal(duplicateName.status, 200);
  assert.deepEqual(
    (await duplicateName.json()).events.map((event) => event.ticketId),
    ['DUP-NOW']
  );
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
    error: '服务器内部错误',
    code: 'INTERNAL_ERROR',
  });
});
