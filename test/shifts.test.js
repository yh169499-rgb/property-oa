const assert = require('node:assert/strict');
const test = require('node:test');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');
const {
  resolveShiftWindow,
  createAssignment,
  createBatchAssignments,
  listAssignments,
} = require('../services/shifts');

async function fixture() {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  db.run("INSERT INTO users (id, phone, password, name, role) VALUES (1, '1', 'x', '管理员', 'admin'), (2, '2', 'x', '员工', 'worker')");
  db.run("INSERT INTO staff_profiles (id, user_id, name) VALUES (10, 2, '员工甲'), (11, NULL, '员工乙')");
  db.run("INSERT INTO shift_templates (id, name, start_time, end_time, created_by) VALUES (20, '白班', '08:00', '18:00', 1), (21, '夜班', '22:00', '06:00', 1)");
  return db;
}

test('resolves normal and overnight shift windows in Shanghai time', () => {
  assert.deepEqual(resolveShiftWindow('2026-07-30', '08:00', '18:00'), {
    startAt: '2026-07-30T08:00:00+08:00',
    endAt: '2026-07-30T18:00:00+08:00',
  });
  assert.deepEqual(resolveShiftWindow('2026-07-30', '22:00', '06:00'), {
    startAt: '2026-07-30T22:00:00+08:00',
    endAt: '2026-07-31T06:00:00+08:00',
  });
});

test('creates work assignment from template and lists it', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const created = createAssignment(db, {
    staffId: 10, workDate: '2026-07-30', assignmentType: 'work', templateId: 20,
  }, 1);
  assert.equal(created.start_at, '2026-07-30T08:00:00+08:00');
  assert.equal(created.end_at, '2026-07-30T18:00:00+08:00');
  assert.equal(listAssignments(db, { staffId: 10 }).length, 1);
});

test('batch expands staff by dates and reports conflicts without overwrite', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const input = {
    staffIds: [10, 11], dates: ['2026-07-30', '2026-07-31'],
    assignmentType: 'work', templateId: 21, overwrite: false,
  };
  const rows = createBatchAssignments(db, input, 1);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].end_at.endsWith('2026-07-31T06:00:00+08:00'), true);
  assert.throws(
    () => createBatchAssignments(db, input, 1),
    (error) => error.status === 409
      && error.code === 'SHIFT_ALREADY_EXISTS'
      && error.details.conflicts.length === 4
      && error.details.conflicts[0].staffId === 10
      && error.details.conflicts[0].workDate === '2026-07-30'
  );
});

test('ordinary user cannot write shift templates or assignments', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  for (const [path, body] of [
    ['/api/shift-templates', { name: '白班', startTime: '08:00', endTime: '18:00' }],
    ['/api/shifts', { staffId: 10, workDate: '2026-08-01', assignmentType: 'rest' }],
  ]) {
    const response = await fetch(server.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader({ id: 2, role: 'worker' }) },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
  }
});
