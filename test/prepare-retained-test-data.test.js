const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { writeFixtureDatabase } = require('./helpers/retained-db');

test('默认只预演且不修改源文件', async () => {
  const { prepareRetainedTestData } = require('../scripts/prepare-retained-test-data');
  const source = await writeFixtureDatabase();
  const before = fs.readFileSync(source);
  const result = await prepareRetainedTestData({
    source, apply: false, confirm: '', password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(result.backupPath, null);
  assert.doesNotMatch(JSON.stringify(result), /runtime-secret|password|hash|token/i);
});

test('apply 必须有绝对路径、确认口令和密码', async () => {
  const { prepareRetainedTestData } = require('../scripts/prepare-retained-test-data');
  await assert.rejects(prepareRetainedTestData({
    source: 'data.db', apply: true, confirm: 'RETAINED-TEST-DATA', password: 'runtime-secret',
  }), /绝对路径/);
  await assert.rejects(prepareRetainedTestData({
    source: '/tmp/data.db', apply: true, confirm: '', password: 'runtime-secret',
  }), /确认口令/);
  await assert.rejects(prepareRetainedTestData({
    source: '/tmp/data.db', apply: true, confirm: 'RETAINED-TEST-DATA', password: '',
  }), /RETAINED_TEST_PASSWORD/);
});

test('apply 先生成同目录备份再原子写回', async () => {
  const { prepareRetainedTestData } = require('../scripts/prepare-retained-test-data');
  const source = await writeFixtureDatabase();
  const before = fs.readFileSync(source);
  const result = await prepareRetainedTestData({
    source, apply: true, confirm: 'RETAINED-TEST-DATA', password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  });
  assert.deepEqual(fs.readFileSync(result.backupPath), before);
  assert.notDeepEqual(fs.readFileSync(source), before);
  assert.equal(fs.existsSync(`${source}.tmp`), false);
});
