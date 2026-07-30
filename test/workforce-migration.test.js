const assert = require('node:assert/strict');
const test = require('node:test');
const { ensureWorkforceSchema } = require('../workforce-schema');
const {
  migrateUsersToProfiles,
  backfillTicketAssignees,
  listUnmatchedAssignees,
} = require('../services/workforce-migration');
const { createTestDB } = require('./helpers/test-db');

function rowsFrom(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function insertUser(db, phone, name, role) {
  db.run(
    'INSERT INTO users (phone, password, name, role) VALUES (?, ?, ?, ?)',
    [phone, 'password', name, role]
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

test('user migration creates one profile per user with role positions and preserved identity fields', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  ensureWorkforceSchema(db);

  insertUser(db, '13800000001', '管理员', 'admin');
  insertUser(db, '13800000002', '组长', 'lead');
  insertUser(db, '13800000003', '维修员', 'worker');
  insertUser(db, '13800000004', '管家', 'keeper');
  insertUser(db, '13800000005', '访客', 'other');

  const nowIso = '2026-07-30T08:00:00.000Z';
  migrateUsersToProfiles(db, nowIso);
  migrateUsersToProfiles(db, '2026-07-31T08:00:00.000Z');

  const profiles = rowsFrom(
    db,
    'SELECT user_id, name, phone, position, created_at, updated_at FROM staff_profiles ORDER BY user_id'
  );
  assert.equal(profiles.length, 5);
  assert.deepEqual(
    profiles.map(({ name, phone, position }) => ({ name, phone, position })),
    [
      { name: '管理员', phone: '13800000001', position: '主管' },
      { name: '组长', phone: '13800000002', position: '主管' },
      { name: '维修员', phone: '13800000003', position: '维修师傅' },
      { name: '管家', phone: '13800000004', position: '物业管家' },
      { name: '访客', phone: '13800000005', position: '员工' },
    ]
  );
  assert.equal(profiles.every((profile) => profile.created_at === nowIso), true);
  assert.equal(profiles.every((profile) => profile.updated_at === nowIso), true);
});

test('ticket migration backfills only unique names and never overwrites an existing assignee', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  ensureWorkforceSchema(db);

  const uniqueUserId = insertUser(db, '13800000011', '唯一师傅', 'worker');
  insertUser(db, '13800000012', '同名师傅', 'worker');
  insertUser(db, '13800000013', '同名师傅', 'keeper');
  const existingAssigneeId = insertUser(db, '13800000014', '既有负责人', 'lead');
  migrateUsersToProfiles(db, '2026-07-30T08:00:00.000Z');

  db.run("INSERT INTO tickets (id, worker) VALUES ('unique', '唯一师傅')");
  db.run("INSERT INTO tickets (id, worker) VALUES ('duplicate', '同名师傅')");
  db.run("INSERT INTO tickets (id, worker) VALUES ('missing', '不存在')");
  db.run("INSERT INTO tickets (id, worker) VALUES ('blank', '')");
  db.run(
    "INSERT INTO tickets (id, worker, assignee_user_id) VALUES ('assigned', '唯一师傅', ?)",
    [existingAssigneeId]
  );

  backfillTicketAssignees(db);
  backfillTicketAssignees(db);

  const tickets = Object.fromEntries(
    rowsFrom(
      db,
      'SELECT id, assignee_user_id FROM tickets ORDER BY id'
    ).map((ticket) => [ticket.id, ticket.assignee_user_id])
  );
  assert.equal(tickets.unique, uniqueUserId);
  assert.equal(tickets.duplicate, null);
  assert.equal(tickets.missing, null);
  assert.equal(tickets.blank, null);
  assert.equal(tickets.assigned, existingAssigneeId);
});

test('unmatched assignee list groups nonblank unresolved worker names', async (t) => {
  const db = await createTestDB();
  t.after(() => db.close());
  ensureWorkforceSchema(db);

  db.run("INSERT INTO tickets (id, worker) VALUES ('a', '待关联')");
  db.run("INSERT INTO tickets (id, worker) VALUES ('b', '待关联')");
  db.run("INSERT INTO tickets (id, worker) VALUES ('c', '另一个')");
  db.run("INSERT INTO tickets (id, worker) VALUES ('d', '')");

  assert.deepEqual(listUnmatchedAssignees(db), [
    { worker: '另一个', ticket_count: 1 },
    { worker: '待关联', ticket_count: 2 },
  ]);
});
