const assert = require('node:assert/strict');
const test = require('node:test');
const { writeFixtureDatabase } = require('./helpers/retained-db');
const fs = require('node:fs');
const initSqlJs = require('sql.js');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function jsonRequest(server, path, options = {}) {
  const response = await fetch(`${server.url}${path}`, options);
  return { response, body: await response.json() };
}

async function fixture() {
  const source = await writeFixtureDatabase();
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(source));
  db.run("INSERT INTO users (id, phone, password, name, role, status) VALUES (99, '13800000001', 'hash', '主管', '主管', 'active')");
  db.run("INSERT INTO users (id, phone, password, name, role, status) VALUES (2, '13800000002', 'hash', '张师傅', 'worker', 'active')");
  return db;
}

test('只有主管可通过一次性部署令牌写入完整模拟数据', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db, {
    deployment: {
      token: 'one-time-deploy-token',
      password: 'runtime-only-password',
      now: new Date('2026-08-13T06:00:00.000Z'),
    },
  });
  t.after(() => server.close());

  const worker = await jsonRequest(server, '/api/admin/mock-data/apply', {
    method: 'POST',
    headers: { ...authHeader({ id: 2, role: 'worker' }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'one-time-deploy-token' }),
  });
  assert.equal(worker.response.status, 403);

  const badToken = await jsonRequest(server, '/api/admin/mock-data/apply', {
    method: 'POST',
    headers: { ...authHeader({ id: 99, role: '主管' }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong' }),
  });
  assert.equal(badToken.response.status, 403);

  const applied = await jsonRequest(server, '/api/admin/mock-data/apply', {
    method: 'POST',
    headers: { ...authHeader({ id: 99, role: '主管' }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'one-time-deploy-token' }),
  });
  assert.equal(applied.response.status, 200);
  assert.equal(applied.body.data.summary.retainedAccounts, 5);
  assert.ok(applied.body.data.summary.mockTickets >= 1);
});
