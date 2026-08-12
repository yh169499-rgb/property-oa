const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const initSqlJs = require('sql.js');
const { writeFixtureDatabase } = require('./helpers/retained-db');

async function migratedFixtureDatabase() {
  const { prepareRetainedTestData } = require('../scripts/prepare-retained-test-data');
  const source = await writeFixtureDatabase();
  await prepareRetainedTestData({
    source, apply: true, confirm: 'RETAINED-TEST-DATA', password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  });
  return source;
}

async function mutateDatabase(source, callback) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(source));
  callback(db);
  fs.writeFileSync(source, Buffer.from(db.export()));
  db.close();
}

test('验证器确认账号、组织、工单和绩效样本完整', async () => {
  const { verifyRetainedTestData } = require('../scripts/verify-retained-test-data');
  const source = await migratedFixtureDatabase();
  const result = await verifyRetainedTestData({ source, password: 'runtime-secret' });
  assert.equal(result.ok, true);
  assert.equal(result.accounts.active, 7);
  assert.equal(result.accounts.loginVerified, 7);
  assert.equal(result.organization.managedBySupervisor, 6);
  assert.ok(result.mockTickets.completedPerPerson.every(count => count >= 5));
  assert.equal(result.problems.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /runtime-secret|password|hash|token/i);
});

test('验证器报告未停用账号和不完整绩效样本', async () => {
  const { verifyRetainedTestData } = require('../scripts/verify-retained-test-data');
  const source = await migratedFixtureDatabase();
  await mutateDatabase(source, db => {
    db.run("INSERT INTO users (phone, password, name, role, status) VALUES ('13999999999', 'x', '意外账号', 'worker', 'active')");
    db.run("DELETE FROM tickets WHERE id LIKE 'MOCK-E2E-02-DONE-%'");
  });
  const result = await verifyRetainedTestData({ source, password: 'runtime-secret' });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(problem => problem.code === 'UNEXPECTED_ACTIVE_ACCOUNT'));
  assert.ok(result.problems.some(problem => problem.code === 'INSUFFICIENT_PERFORMANCE_SAMPLE'));
});
