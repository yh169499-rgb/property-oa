const assert = require('node:assert/strict');
const test = require('node:test');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function fixture() {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  db.run(`INSERT INTO users (id, phone, password, name, role) VALUES
    (1, '1', 'x', '主管', 'lead'), (2, '2', 'x', '师傅', 'worker')`);
  db.run(`INSERT INTO staff_profiles (id, user_id, name) VALUES (10, 2, '师傅')`);
  db.run(`INSERT INTO attendance_records (id, staff_id, work_date, status) VALUES (30, 10, '2026-08-04', 'normal')`);
  return db;
}

test('主管 can delete attendance and ordinary users cannot', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const deleted = await fetch(`${server.url}/api/attendance/30`, {
    method: 'DELETE', headers: authHeader({ id: 1, role: 'lead' }),
  });
  assert.equal(deleted.status, 200);
  assert.equal(db.exec('SELECT id FROM attendance_records WHERE id = 30').length, 0);

  db.run("INSERT INTO attendance_records (id, staff_id, work_date, status) VALUES (31, 10, '2026-08-05', 'late')");
  const forbidden = await fetch(`${server.url}/api/attendance/31`, {
    method: 'DELETE', headers: authHeader({ id: 2, role: 'worker' }),
  });
  assert.equal(forbidden.status, 403);
});

test('deleting an unknown attendance record returns a stable code', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/attendance/999`, {
    method: 'DELETE', headers: authHeader({ id: 1, role: 'lead' }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'ATTENDANCE_NOT_FOUND');
});
