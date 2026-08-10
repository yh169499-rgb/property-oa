const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');

async function fixture(communities) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '其他',
      desc TEXT DEFAULT '', loc TEXT DEFAULT '', priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'wait', worker TEXT DEFAULT '', message TEXT DEFAULT '',
      created TEXT NOT NULL, finished TEXT DEFAULT '', estimated_hours REAL DEFAULT 0,
      session_id TEXT DEFAULT '', community_id TEXT DEFAULT 'default', repeat_key TEXT DEFAULT '',
      repeat_of TEXT DEFAULT '', repeat_count INTEGER DEFAULT 1, is_recurring INTEGER DEFAULT 0,
      recurrence_note TEXT DEFAULT '', feedback_count INTEGER DEFAULT 1, metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE communities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '', created TEXT NOT NULL
    );
  `);
  ensureWorkforceSchema(db);
  for (const community of communities) {
    db.run('INSERT INTO communities (id, name, created) VALUES (?, ?, ?)', [community.id, community.name, '2026-01-01T00:00:00Z']);
  }
  return db;
}

async function create(server, body) {
  const response = await fetch(`${server.url}/api/tickets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('单小区缺省归属该小区，多小区缺省返回 COMMUNITY_REQUIRED', async (t) => {
  const single = await fixture([{ id: 'only', name: '唯一小区' }]);
  const singleServer = await startHttpServer(single);
  t.after(() => singleServer.close());
  const created = await create(singleServer, { id: 'single-ticket', desc: '漏水' });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.record.community_id, 'only');

  const multi = await fixture([{ id: 'c1', name: '一号小区' }, { id: 'c2', name: '二号小区' }]);
  const multiServer = await startHttpServer(multi);
  t.after(() => multiServer.close());
  const missing = await create(multiServer, { id: 'missing-ticket', desc: '漏水' });
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.code, 'COMMUNITY_REQUIRED');
});

test('兼容 communityId、拒绝未知和冲突小区', async (t) => {
  const db = await fixture([{ id: 'c1', name: '一号小区' }, { id: 'c2', name: '二号小区' }]);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const alias = await create(server, { id: 'alias-ticket', communityId: 'c1', desc: '跳闸' });
  assert.equal(alias.response.status, 200);
  assert.equal(alias.body.record.community_id, 'c1');
  const unknown = await create(server, { id: 'unknown-ticket', community_id: 'ghost', desc: '跳闸' });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.code, 'COMMUNITY_NOT_FOUND');
  const conflict = await create(server, { id: 'conflict-ticket', community_id: 'c1', communityId: 'c2', desc: '跳闸' });
  assert.equal(conflict.response.status, 400);
  assert.equal(conflict.body.code, 'COMMUNITY_CONFLICT');
});

test('唯一小区名称可解析，重名名称拒绝', async (t) => {
  const db = await fixture([{ id: 'c1', name: '一号小区' }, { id: 'c2', name: '重复小区' }, { id: 'c3', name: '重复小区' }]);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const resolved = await create(server, { id: 'name-ticket', community_name: '一号小区', desc: '漏水' });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.body.record.community_id, 'c1');
  const duplicate = await create(server, { id: 'duplicate-name-ticket', community_name: '重复小区', desc: '漏水' });
  assert.equal(duplicate.response.status, 400);
  assert.equal(duplicate.body.code, 'COMMUNITY_AMBIGUOUS');
});
