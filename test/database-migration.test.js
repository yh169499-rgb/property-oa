const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const {
  parseMigrationArgs,
  migrateSqliteFile,
} = require('../scripts/migrate-sqlite-to-supabase');

test('迁移命令必须显式确认，避免误覆盖远程数据库', () => {
  assert.throws(
    () => parseMigrationArgs(['--source=/tmp/data.db']),
    /--confirm/
  );
});

test('迁移摘要包含所有表和记录数且不输出敏感值', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT, password TEXT)');
  db.run("INSERT INTO users (phone, password) VALUES ('13800000001', 'hash')");
  db.run('CREATE TABLE tickets (id TEXT PRIMARY KEY, desc TEXT)');
  db.run("INSERT INTO tickets (id, desc) VALUES ('WX-1', '漏水')");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'));
  const source = path.join(directory, 'data.db');
  fs.writeFileSync(source, Buffer.from(db.export()));
  let uploaded;
  const result = await migrateSqliteFile({
    source,
    confirm: true,
    upload: async (bytes) => { uploaded = bytes; return { backupPath: 'backups/test.data.db' }; },
  });
  assert.equal(result.tables.users.count, 1);
  assert.equal(result.tables.tickets.count, 1);
  assert.equal(result.tables.users.password, undefined);
  assert.ok(Buffer.isBuffer(uploaded));
  assert.ok(fs.existsSync(`${source}.bak`));
});