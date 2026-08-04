const assert = require('node:assert/strict');
const test = require('node:test');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { seedDemo } = require('../scripts/seed-workforce-demo');

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker'
  )`);
  db.run(`CREATE TABLE tickets (
    id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '', desc TEXT DEFAULT '',
    loc TEXT DEFAULT '', priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'wait', worker TEXT DEFAULT '',
    message TEXT DEFAULT '', created TEXT DEFAULT '', finished TEXT DEFAULT '', estimated_hours REAL DEFAULT 0,
    community_id TEXT DEFAULT 'default', assignee_user_id INTEGER, assigned_at TEXT DEFAULT ''
  )`);
  ensureWorkforceSchema(db);
  db.run(`INSERT INTO users (id, phone, password, name, role) VALUES
    (8, '13800000011', 'hash', '测试主管', 'lead'),
    (9, '13800000012', 'hash', '测试师傅', 'worker'),
    (10, '13800000013', 'hash', '测试管家', 'worker')`);
  return db;
}

function count(db, table) {
  return db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0];
}

test('demo seed is idempotent and creates connected workforce data', async () => {
  const db = await fixture();
  const first = seedDemo(db, new Date('2026-08-04T04:00:00.000Z'));
  const countsAfterFirst = ['staff_profiles', 'shift_templates', 'shift_assignments', 'attendance_records', 'tickets']
    .map((table) => count(db, table));
  const second = seedDemo(db, new Date('2026-08-04T04:00:00.000Z'));
  const countsAfterSecond = ['staff_profiles', 'shift_templates', 'shift_assignments', 'attendance_records', 'tickets']
    .map((table) => count(db, table));

  assert.deepEqual(countsAfterSecond, countsAfterFirst);
  assert.ok(countsAfterFirst[1] >= 2);
  assert.ok(countsAfterFirst[2] >= 6);
  assert.ok(countsAfterFirst[3] >= 3);
  assert.ok(countsAfterFirst[4] >= 6);
  assert.equal(first.inserted.tickets, 6);
  assert.equal(second.inserted.tickets, 0);
  assert.doesNotMatch(JSON.stringify({ first, second }), /password|jwt/i);
});
