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

test('package 暴露预演、执行和验证命令且文档不泄露运行时密码', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['retained:dry-run'], 'node scripts/prepare-retained-test-data.js');
  assert.equal(pkg.scripts['retained:apply'],
    'node scripts/prepare-retained-test-data.js --apply --confirm=RETAINED-TEST-DATA');
  assert.equal(pkg.scripts['retained:verify'], 'node scripts/verify-retained-test-data.js');
  const docs = [
    fs.readFileSync('README.md', 'utf8'),
    fs.readFileSync('docs/SECURITY-AUDIT.md', 'utf8'),
    fs.readFileSync('docs/API.md', 'utf8'),
  ].join('\n');
  assert.match(docs, /RETAINED_TEST_PASSWORD/);
  assert.match(docs, /Render.*备份|备份.*Render/s);
  assert.match(docs, /回滚/);
  assert.doesNotMatch(docs, /RETAINED_TEST_PASSWORD\s*=\s*['"]?[A-Za-z0-9@._-]{8,}/);
});
