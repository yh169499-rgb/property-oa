const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { verifyPersistence } = require('../scripts/verify-supabase-persistence');

test('迁移验证比较本地与远程表集合和记录数', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT)');
  db.run("INSERT INTO users (phone) VALUES ('13800000001')");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-persistence-'));
  const source = path.join(directory, 'data.db');
  const bytes = Buffer.from(db.export());
  fs.writeFileSync(source, bytes);
  const result = await verifyPersistence({ source, download: async () => bytes });
  assert.equal(result.match, true);
  assert.equal(result.local.tables.users.count, 1);
  assert.equal(result.remote.tables.users.count, 1);
});

test('远程对象缺失时验证失败', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-persistence-'));
  const source = path.join(directory, 'data.db');
  fs.writeFileSync(source, Buffer.from(db.export()));
  await assert.rejects(
    verifyPersistence({ source, download: async () => null }),
    /remote database snapshot is missing/
  );
});