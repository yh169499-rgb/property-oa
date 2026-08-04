const assert = require('node:assert/strict');
const test = require('node:test');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');
const {
  resolveShiftWindow,
  validateAssignment,
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

test('batch validates every pair and rolls back invalid or duplicate input', async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  assert.throws(() => createBatchAssignments(db, {
    staffIds: [10],
    dates: ['2026-07-30', '2026-02-31'],
    assignmentType: 'rest',
    overwrite: false,
  }, 1), /workDate/);
  assert.equal(listAssignments(db).length, 0);

  assert.throws(
    () => createBatchAssignments(db, {
      staffIds: [10, 10],
      dates: ['2026-07-30'],
      assignmentType: 'rest',
      overwrite: false,
    }, 1),
    (error) => error.status === 409
      && error.code === 'SHIFT_ALREADY_EXISTS'
      && error.details.conflicts.length === 1
  );
  assert.equal(listAssignments(db).length, 0);
});

test('strictly validates calendar dates, clock times, and custom absolute windows', () => {
  assert.throws(() => resolveShiftWindow('2026-02-31', '08:00', '18:00'), /格式无效/);
  assert.throws(() => resolveShiftWindow('2026-07-30', '25:99', '18:00'), /格式无效/);
  assert.throws(() => validateAssignment({
    staffId: 10, workDate: '2026-07-30', assignmentType: 'work',
    startAt: '2026-07-30 08:00', endAt: '2026-07-30T18:00:00+08:00',
  }), /起止时间/);
  assert.throws(() => validateAssignment({
    staffId: 10, workDate: '2026-07-30', assignmentType: 'work',
    startAt: '2026-07-30T18:00:00+08:00', endAt: '2026-07-30T08:00:00+08:00',
  }), /起止时间/);
  assert.throws(() => validateAssignment({
    staffId: 10, workDate: '2026-07-30', assignmentType: 'work',
    startAt: '2026-07-31T08:00:00+08:00', endAt: '2026-07-31T18:00:00+08:00',
  }), /workDate/);
  assert.throws(() => validateAssignment({
    staffId: 10, workDate: '2026-07-30', assignmentType: 'work',
    startAt: '2026-07-30T20:00:00-10:00', endAt: '2026-07-31T06:00:00-10:00',
  }), /workDate/);
});

test('rejects nonexistent staff without creating an orphan assignment', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  assert.throws(
    () => createAssignment(db, {
      staffId: 999, workDate: '2026-07-30', assignmentType: 'rest',
    }, 1),
    (error) => error.status === 404 && error.code === 'STAFF_NOT_FOUND'
  );
  assert.equal(listAssignments(db).length, 0);
});

test('PATCH conflict preserves both original assignments and rejects invalid template time', async (t) => {
  const db = await fixture();
  createAssignment(db, {
    staffId: 10, workDate: '2026-07-30', assignmentType: 'rest',
  }, 1);
  createAssignment(db, {
    staffId: 11, workDate: '2026-07-31', assignmentType: 'rest',
  }, 1);
  const before = listAssignments(db).map(({ id, staff_id, work_date }) => ({ id, staff_id, work_date }));
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const headers = {
    'Content-Type': 'application/json',
    ...authHeader({ id: 1, role: 'admin' }),
  };

  const conflict = await fetch(`${server.url}/api/shifts/${before[0].id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ staffId: 11, workDate: '2026-07-31' }),
  });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.code, 'SHIFT_ALREADY_EXISTS');
  assert.deepEqual(listAssignments(db).map(({ id, staff_id, work_date }) => ({
    id, staff_id, work_date,
  })), before);

  const badTemplate = await fetch(`${server.url}/api/shift-templates`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '坏班次', startTime: '25:99', endTime: '18:00' }),
  });
  assert.equal(badTemplate.status, 400);
  assert.equal((await badTemplate.json()).code, 'INVALID_SHIFT_TEMPLATE');
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

test('admin can delete unused templates but referenced templates are protected', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const headers = { ...authHeader({ id: 1, role: 'admin' }) };

  const unused = await fetch(`${server.url}/api/shift-templates/20`, {
    method: 'DELETE', headers,
  });
  assert.equal(unused.status, 200);
  assert.equal(db.exec('SELECT id FROM shift_templates WHERE id = 20').length, 0);

  createAssignment(db, {
    staffId: 10, workDate: '2026-07-30', assignmentType: 'work', templateId: 21,
  }, 1);
  const referenced = await fetch(`${server.url}/api/shift-templates/21`, {
    method: 'DELETE', headers,
  });
  assert.equal(referenced.status, 409);
  assert.equal((await referenced.json()).code, 'SHIFT_TEMPLATE_IN_USE');
  assert.equal(db.exec('SELECT id FROM shift_templates WHERE id = 21').length, 1);
});

test('ordinary user cannot delete shift templates', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/shift-templates/20`, {
    method: 'DELETE', headers: authHeader({ id: 2, role: 'worker' }),
  });
  assert.equal(response.status, 403);
});
