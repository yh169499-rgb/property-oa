const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../../workforce-schema');

async function writeFixtureDatabase() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker',
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '',
      desc TEXT DEFAULT '', loc TEXT DEFAULT '', priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'wait', worker TEXT DEFAULT '', message TEXT DEFAULT '',
      created TEXT NOT NULL, finished TEXT DEFAULT '', reject_reason TEXT DEFAULT '',
      estimated_hours REAL DEFAULT 0, community_id TEXT DEFAULT 'default',
      repeat_key TEXT DEFAULT '', repeat_of TEXT DEFAULT '', repeat_count INTEGER DEFAULT 1,
      is_recurring INTEGER DEFAULT 0, recurrence_note TEXT DEFAULT '',
      feedback_count INTEGER DEFAULT 1, metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE communities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '', created TEXT NOT NULL
    );
    CREATE TABLE staff_status (name TEXT PRIMARY KEY, status TEXT, updated TEXT);
  `);
  ensureWorkforceSchema(db);
  db.run("INSERT INTO users (phone, password, name, role) VALUES ('13900000000', 'old-hash', '旧账号', 'worker')");
  db.run("INSERT INTO communities (id, name, created) VALUES ('default', '默认小区', '2025-01-01')");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-data-test-'));
  const source = path.join(directory, 'data.db');
  fs.writeFileSync(source, Buffer.from(db.export()));
  db.close();
  return source;
}

module.exports = { writeFixtureDatabase };

