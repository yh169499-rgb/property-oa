const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { createTestDB } = require('./helpers/test-db');
const { tenantServer } = require('./helpers/tenant-fixture');
const { authHeader } = require('./helpers/auth');
const { ensureWorkforceSchema } = require('../workforce-schema');

const {
  detectTicketAction,
  resolveAssignee,
  recordTicketActivity,
} = require('../services/ticket-activity');

test('detectTicketAction recognizes the six workflow actions', () => {
  const wait = { status: 'wait', worker: '' };
  const doing = { status: 'doing', worker: '张师傅' };
  const pending = { status: 'pending', worker: '张师傅' };
  const confirm = { status: 'confirm', worker: '张师傅' };

  assert.equal(detectTicketAction(wait, { worker: '张师傅', status: 'doing' }), 'assign');
  assert.equal(detectTicketAction(confirm, { status: 'done' }), 'approve_complete');
  assert.equal(detectTicketAction(confirm, { status: 'doing', rejectReason: '材料不足' }), 'reject');
  assert.equal(detectTicketAction(doing, { status: 'pending' }), 'suspend');
  assert.equal(detectTicketAction(pending, { status: 'doing' }), 'resume');
  assert.equal(detectTicketAction(doing, { _action: 'urge' }), 'urge');
});

test('detectTicketAction ignores metadata and unsupported explicit actions', () => {
  const doing = { status: 'doing', worker: '张师傅' };
  assert.equal(detectTicketAction(doing, { metadata: '{"urged":[]}' }), null);
  assert.equal(detectTicketAction(doing, { _action: 'approve_complete' }), null);
});

test('resolveAssignee returns stable identity only for a unique active direct report', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT DEFAULT 'worker', status TEXT DEFAULT 'active')");
  db.run(`CREATE TABLE staff_profiles (
    id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, manager_id INTEGER,
    employment_status TEXT DEFAULT 'active'
  )`);
  db.run("INSERT INTO users (id) VALUES (1), (11), (12), (13), (14), (15), (16)");
  db.run("UPDATE users SET role = 'guest' WHERE id = 16");
  db.run(`INSERT INTO staff_profiles
    (id, user_id, name, manager_id, employment_status) VALUES
    (1, 1, '主管', NULL, 'active'),
    (2, 11, '唯一师傅', 1, 'active'),
    (3, 12, '重名师傅', 1, 'active'),
    (4, 13, '重名师傅', 1, 'active'),
    (5, 14, '离职师傅', 1, 'departed'),
    (6, 15, '外部师傅', NULL, 'active'),
    (7, 16, '非处理岗位', 1, 'active')`);

  assert.deepEqual(resolveAssignee(db, '唯一师傅', 1), {
    assigneeUserId: 11,
    assigneeStaffProfileId: 2,
    displayName: '唯一师傅',
  });
  for (const name of ['重名师傅', '离职师傅', '外部师傅', '非处理岗位', '不存在', '']) {
    assert.throws(
      () => resolveAssignee(db, name, 1),
      (error) => error.status === 409 && error.code === 'ASSIGNEE_NOT_ELIGIBLE',
      name
    );
  }
});

test('recordTicketActivity inserts a parameterized activity row', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE ticket_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT,
      actor_user_id INTEGER,
      actor_staff_id INTEGER,
      action TEXT,
      metadata TEXT,
      created_at TEXT
    )
  `);

  recordTicketActivity(db, {
    ticketId: "WX'7",
    actorUserId: 3,
    actorStaffId: 9,
    action: 'reject',
    metadata: { reason: "材料'不足" },
    createdAt: '2026-07-30T10:00:00.000Z',
  });

  const row = db.exec('SELECT * FROM ticket_activity_logs')[0].values[0];
  assert.deepEqual(row, [
    1, "WX'7", 3, 9, 'reject', '{"reason":"材料\'不足"}',
    '2026-07-30T10:00:00.000Z',
  ]);
});

async function apiFixture(t) {
  const db = await createTestDB();
  db.run("ALTER TABLE tickets ADD COLUMN status TEXT DEFAULT 'wait'");
  db.run("ALTER TABLE tickets ADD COLUMN metadata TEXT DEFAULT '{}'");
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', '主管'),
      (2, '13800000002', 'x', '唯一师傅', 'worker')
  `);
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO staff_profiles (user_id, name, created_at, updated_at) VALUES
      (1, '主管', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'),
      (2, '唯一师傅', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')
  `);
  db.run(`UPDATE staff_profiles
    SET manager_id = (SELECT id FROM staff_profiles WHERE user_id = 1)
    WHERE user_id = 2`);
  db.run(`
    INSERT INTO tickets (id, worker, status, metadata) VALUES
      ('WX1', '', 'wait', '{}'),
      ('WX2', '唯一师傅', 'doing', '{}')
  `);
  db.run(`
    UPDATE tickets
    SET assignee_user_id = 2, assigned_at = '2026-07-30T01:00:00.000Z'
    WHERE id = 'WX2'
  `);
  const server = await tenantServer(db);
  t.after(() => server.close());
  return { db, server };
}

async function patchTicket(server, id, body, headers = {}) {
  const response = await fetch(`${server.url}/api/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function firstRow(db, sql) {
  const result = db.exec(sql);
  return result[0] ? result[0].values[0] : undefined;
}

test('Bearer PATCH records actor activity and keeps _action out of ticket SQL', async (t) => {
  const { db, server } = await apiFixture(t);
  const headers = authHeader({ id: 1, name: '主管', role: 'lead' });

  const assigned = await patchTicket(
    server,
    'WX1',
    { worker: '唯一师傅', status: 'doing' },
    headers
  );
  assert.equal(assigned.response.status, 200);
  assert.deepEqual(
    firstRow(db, "SELECT worker, assignee_user_id, assignee_staff_profile_id, assigned_at IS NOT NULL FROM tickets WHERE id = 'WX1'"),
    ['唯一师傅', 2, 2, 1]
  );
  assert.deepEqual(
    firstRow(db, 'SELECT actor_user_id, action FROM ticket_activity_logs ORDER BY id'),
    [1, 'assign']
  );

  const urged = await patchTicket(
    server,
    'WX1',
    { metadata: '{"urged":[1]}', _action: 'urge' },
    headers
  );
  assert.equal(urged.response.status, 200);
  assert.deepEqual(
    firstRow(db, 'SELECT action FROM ticket_activity_logs ORDER BY id DESC LIMIT 1'),
    ['urge']
  );
});

test('anonymous PATCH is rejected and staff cannot clear stable assignment', async (t) => {
  const { db, server } = await apiFixture(t);

  const suspended = await patchTicket(server, 'WX2', { status: 'pending' });
  assert.equal(suspended.response.status, 401);
  assert.deepEqual(firstRow(db, "SELECT status FROM tickets WHERE id = 'WX2'"), ['doing']);
  assert.equal(firstRow(db, 'SELECT COUNT(*) FROM ticket_activity_logs')[0], 0);

  const cleared = await patchTicket(server, 'WX2', { worker: '' }, authHeader({ id: 2, role: 'worker', name: '唯一师傅' }));
  assert.equal(cleared.response.status, 403);
  assert.equal(cleared.body.code, 'TICKET_SCOPE_FORBIDDEN');
  assert.deepEqual(
    firstRow(db, "SELECT worker, assignee_user_id, assigned_at FROM tickets WHERE id = 'WX2'"),
    ['唯一师傅', 2, '2026-07-30T01:00:00.000Z']
  );
  assert.equal(firstRow(db, 'SELECT COUNT(*) FROM ticket_activity_logs')[0], 0);
});

test('ticket update rolls back when activity insert fails', async (t) => {
  const { db, server } = await apiFixture(t);
  db.run(`
    CREATE TRIGGER reject_ticket_activity
    BEFORE INSERT ON ticket_activity_logs
    BEGIN
      SELECT RAISE(ABORT, 'simulated activity failure');
    END
  `);

  const result = await patchTicket(
    server,
    'WX1',
    { worker: '唯一师傅', status: 'doing' },
    authHeader({ id: 1, name: '主管', role: 'lead' })
  );

  assert.equal(result.response.status, 500);
  assert.deepEqual(
    firstRow(db, "SELECT worker, status, assignee_user_id, assigned_at FROM tickets WHERE id = 'WX1'"),
    ['', 'wait', null, '']
  );
  assert.equal(firstRow(db, 'SELECT COUNT(*) FROM ticket_activity_logs')[0], 0);
});
