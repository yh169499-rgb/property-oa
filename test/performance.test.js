const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, phone TEXT, password TEXT, name TEXT, role TEXT
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '',
      status TEXT DEFAULT 'wait', priority TEXT DEFAULT 'normal', worker TEXT DEFAULT '',
      created TEXT NOT NULL, finished TEXT DEFAULT '', estimated_hours REAL DEFAULT 0,
      assigned_at TEXT DEFAULT '', assignee_user_id INTEGER, community_id TEXT DEFAULT 'default',
      reject_reason TEXT DEFAULT '', feedback_count INTEGER DEFAULT 1,
      is_recurring INTEGER DEFAULT 0
    );
  `);
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', 'lead'),
      (2, '13800000002', 'x', '师傅', 'worker');
    INSERT INTO staff_profiles (id, user_id, name, position) VALUES
      (1, 1, '主管', '主管'), (2, 2, '师傅', '维修师傅');
  `);
  return db;
}

test('绩效规则校验拒绝权重不等于100和逆序阈值', () => {
  const { validateRule } = require('../services/performance');
  assert.throws(() => validateRule({
    completion_weight: 20, on_time_weight: 20, quality_weight: 20,
    excellent_threshold: 90, good_threshold: 80, qualified_threshold: 60,
    minimum_sample_size: 1,
  }), /权重/);
  assert.throws(() => validateRule({
    completion_weight: 30, on_time_weight: 50, quality_weight: 20,
    excellent_threshold: 60, good_threshold: 80, qualified_threshold: 90,
    minimum_sample_size: 1,
  }), /阈值/);
});

test('三项评分按权重计算并四舍五入到一位小数', () => {
  const { calculateScore } = require('../services/performance');
  const result = calculateScore({ completion: 100, onTime: 90, quality: 57.5 }, {
    completion_weight: 30, on_time_weight: 50, quality_weight: 20,
    excellent_threshold: 90, good_threshold: 80, qualified_threshold: 60,
  });
  assert.equal(result.score, 86.5);
  assert.equal(result.level, 'good');
  assert.equal(result.status, 'scored');
});

test('无样本返回 insufficient_sample，单项无样本时剩余权重归一化', () => {
  const { calculateScore } = require('../services/performance');
  const empty = calculateScore({ completion: null, onTime: null, quality: null }, {
    completion_weight: 30, on_time_weight: 50, quality_weight: 20,
    excellent_threshold: 90, good_threshold: 80, qualified_threshold: 60,
    minimum_sample_size: 1,
  }, 0);
  assert.equal(empty.status, 'insufficient_sample');

  const partial = calculateScore({ completion: 80, onTime: null, quality: 100 }, {
    completion_weight: 30, on_time_weight: 50, quality_weight: 20,
    excellent_threshold: 90, good_threshold: 80, qualified_threshold: 60,
    minimum_sample_size: 1,
  }, 2);
  assert.equal(partial.status, 'scored');
  assert.equal(partial.score, 88);
  assert.equal(partial.components.onTime.status, 'no_sample');
});

test('发布规则生成新版本且旧版本保持只读和可查询', async () => {
  const db = await fixture();
  const { createRuleVersion, getActiveRule, listRuleVersions } = require('../services/performance');
  const created = createRuleVersion(db, {
    name: '夏季规则', completion_weight: 40, on_time_weight: 40, quality_weight: 20,
    excellent_threshold: 95, good_threshold: 85, qualified_threshold: 70,
    minimum_sample_size: 2,
  }, 1);
  assert.equal(created.version_no, 2);
  assert.equal(getActiveRule(db).version_no, 2);
  assert.deepEqual(listRuleVersions(db).map((version) => version.version_no), [1, 2]);
  assert.equal(listRuleVersions(db).find((version) => version.version_no === 1).is_active, 0);
  assert.throws(() => createRuleVersion(db, {
    name: '坏规则', completion_weight: 101, on_time_weight: 0, quality_weight: 0,
    excellent_threshold: 90, good_threshold: 80, qualified_threshold: 60,
    minimum_sample_size: 1,
  }, 1), /权重/);
  assert.equal(listRuleVersions(db).length, 2);
});

test('服务端评分按工单冻结的旧规则版本分组', async () => {
  const db = await fixture();
  const { createRuleVersion, scoreStaff } = require('../services/performance');
  const versionTwo = createRuleVersion(db, {
    name: '新规则', completion_weight: 100, on_time_weight: 0, quality_weight: 0,
    excellent_threshold: 90, good_threshold: 80, qualified_threshold: 60,
    minimum_sample_size: 1,
  }, 1);
  db.run(`
    INSERT INTO tickets
      (id, status, created, assigned_at, finished, estimated_hours, assignee_user_id,
       performance_rule_version_id)
    VALUES
      ('old-ticket', 'done', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z',
       '2026-07-02T01:00:00Z', 2, 2, 1),
      ('new-ticket', 'done', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z',
       '2026-07-03T01:00:00Z', 2, 2, ?)
  `, [versionTwo.id]);
  const report = scoreStaff(db, 2, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(report.status, 'scored');
  assert.deepEqual(report.ruleVersions.map((version) => version.version), [1, 2]);
  assert.equal(report.sampleSize, 2);
  assert.equal(report.ruleVersions[0].sampleSize, 1);
  assert.equal(report.ruleVersions[0].score, 100);
});

test('质量分按唯一工单计数并把复发工单纳入质量依据', async () => {
  const db = await fixture();
  const { scoreStaff } = require('../services/performance');
  db.run(`
    INSERT INTO tickets
      (id, status, created, assigned_at, assignee_user_id, is_recurring, feedback_count)
    VALUES
      ('quality-one', 'doing', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', 2, 0, 1),
      ('quality-repeat', 'doing', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z', 2, 1, 1)
  `);
  const result = scoreStaff(db, 2, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(result.sampleSize, 2);
  assert.equal(result.components.quality.score, 50);
});

test('完成率只使用报告日期范围内完成的工单', async () => {
  const db = await fixture();
  const { scoreStaff } = require('../services/performance');
  db.run(`
    INSERT INTO tickets
      (id, status, created, assigned_at, finished, assignee_user_id)
    VALUES
      ('completed-later', 'done', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z',
       '2026-08-01T00:00:00Z', 2)
  `);
  const result = scoreStaff(db, 2, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(result.components.completion.score, 0);
});

test('评分日期缺失或倒序时返回稳定日期错误', async () => {
  const db = await fixture();
  const { scoreStaff } = require('../services/performance');
  assert.throws(
    () => scoreStaff(db, 2, { from: '2026-07-01' }),
    (error) => error.code === 'INVALID_DATE_RANGE'
  );
  assert.throws(
    () => scoreStaff(db, 2, { from: '2026-08-01', to: '2026-07-01' }),
    (error) => error.code === 'INVALID_DATE_RANGE'
  );
});

test('绩效规则设置接口仅主管可发布并返回历史版本', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const get = async (path, headers) => {
    const response = await fetch(`${server.url}${path}`, { headers });
    return { response, body: await response.json() };
  };
  const post = async (path, body, headers) => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };
  const workerView = await get('/api/settings/performance', authHeader({ id: 2, role: 'worker' }));
  assert.equal(workerView.response.status, 200);
  assert.equal(workerView.body.data.versions.length, 0);
  const created = await post('/api/settings/performance/versions', {
    name: '接口规则', completion_weight: 30, on_time_weight: 50, quality_weight: 20,
    excellent_threshold: 90, good_threshold: 80, qualified_threshold: 60,
    minimum_sample_size: 1,
  }, authHeader({ id: 1, role: 'lead' }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.active.version_no, 2);
  const listed = await get('/api/settings/performance', authHeader({ id: 1, role: 'lead' }));
  assert.deepEqual(listed.body.data.versions.map((version) => version.version_no), [1, 2]);
});
