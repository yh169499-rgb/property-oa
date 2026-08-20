const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

const analysis = {
  summary: '本期整体稳定。',
  highlights: ['按时率较高'],
  issues: ['存在复发工单'],
  trends: ['处理时长平稳'],
  risks: ['重复问题风险'],
  recommendations: ['安排专项巡检'],
};

function enabledConfig() {
  return {
    AI_REPORT_ENABLED: true,
    AI_BASE_URL: 'https://example.test/v1',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'qwen3.6-flash',
    AI_TIMEOUT_MS: 100,
    AI_REPORT_PROMPT_VERSION: 'report-analysis-v1',
  };
}

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, password TEXT, role TEXT);
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '',
      status TEXT DEFAULT 'wait', priority TEXT DEFAULT 'normal', worker TEXT DEFAULT '',
      created TEXT NOT NULL, finished TEXT DEFAULT '', estimated_hours REAL DEFAULT 0,
      community_id TEXT DEFAULT 'default', reject_reason TEXT DEFAULT '',
      is_recurring INTEGER DEFAULT 0, feedback_count INTEGER DEFAULT 1
    );
    CREATE TABLE communities (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
    INSERT INTO communities VALUES ('c1', '一号小区', '2026-01-01T00:00:00Z');
    INSERT INTO communities VALUES ('c2', '二号小区', '2026-01-01T00:00:00Z');
  `);
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO users (id, name, phone, password, role) VALUES
      (1, '组长账号', '13800000101', 'x', 'lead'),
      (2, '组长账号二', '13800000102', 'x', 'lead'),
      (3, '师傅账号', '13800000103', 'x', 'worker'),
      (4, '树外账号', '13800000104', 'x', 'worker'),
      (5, '主管账号', '13800000105', 'x', '主管');
    INSERT INTO staff_profiles (id, user_id, name, position, manager_id) VALUES
      (1, 1, '主管', '主管', NULL),
      (2, 2, '组长', '组长', 1),
      (3, 3, '师傅', '维修师傅', 2),
      (4, 4, '树外人员', '维修师傅', NULL);
    INSERT INTO community_memberships (community_id, staff_profile_id) VALUES
      ('c1', 1), ('c1', 2), ('c1', 3), ('c2', 4);
    INSERT INTO tickets
      (id, status, created, assigned_at, finished, estimated_hours, community_id, assignee_user_id)
    VALUES ('ticket-1', 'done', '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z',
      '2026-08-02T01:00:00Z', 2, 'c1', 3);
  `);
  return db;
}

function appOptions(config = enabledConfig(), onAnalyze) {
  return {
    aiReport: {
      config,
      analyzeReport: async (options) => {
        if (onAnalyze) onAnalyze(options);
        return {
          status: 'ready', cached: false, model: config.AI_MODEL,
          promptVersion: config.AI_REPORT_PROMPT_VERSION, analysis,
        };
      },
    },
  };
}

async function jsonRequest(server, path, options = {}) {
  const response = await fetch(`${server.url}${path}`, options);
  return { response, body: await response.json() };
}

test('AI 状态与分析接口要求登录并返回六段式润色结果', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db, appOptions());
  t.after(() => { db.close(); return server.close(); });

  const anonymous = await jsonRequest(server, '/api/reports/ai/status');
  assert.equal(anonymous.response.status, 401);

  const headers = { ...authHeader({ id: 3, role: 'worker' }), 'Content-Type': 'application/json' };
  const status = await jsonRequest(server, '/api/reports/ai/status', { headers });
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.body.data, { enabled: true, model: 'qwen3.6-flash' });

  const success = await jsonRequest(server, '/api/reports/staff/3/ai-analysis', {
    method: 'POST', headers,
    body: JSON.stringify({ from: '2026-08-01', to: '2026-08-31', community_id: 'c1' }),
  });
  assert.equal(success.response.status, 200);
  assert.deepEqual(Object.keys(success.body.data.analysis).sort(), [
    'highlights', 'issues', 'recommendations', 'risks', 'summary', 'trends',
  ]);

  const team = await jsonRequest(server, '/api/reports/staff/all/ai-analysis', {
    method: 'POST',
    headers: { ...authHeader({ id: 5, role: '主管' }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '2026-08-01', to: '2026-08-31', community_id: 'c1' }),
  });
  assert.equal(team.response.status, 200);
});

test('AI 分析限制本人递归团队和小区范围并校验日期', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db, appOptions());
  t.after(() => { db.close(); return server.close(); });
  const post = (staffId, user, body) => jsonRequest(server, `/api/reports/staff/${staffId}/ai-analysis`, {
    method: 'POST',
    headers: { ...authHeader(user), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const filters = { from: '2026-08-01', to: '2026-08-31', community_id: 'c1' };

  assert.equal((await post(2, { id: 3, role: 'worker' }, filters)).response.status, 403);
  assert.equal((await post(3, { id: 1, role: 'lead' }, filters)).response.status, 200);
  const teamForbidden = await jsonRequest(server, '/api/reports/staff/all/ai-analysis', {
    method: 'POST',
    headers: { ...authHeader({ id: 3, role: 'worker' }), 'Content-Type': 'application/json' },
    body: JSON.stringify(filters),
  });
  assert.equal(teamForbidden.response.status, 403);
  assert.equal((await post(4, { id: 1, role: 'lead' }, { ...filters, community_id: 'c2' })).response.status, 403);
  const crossCommunity = await post(3, { id: 1, role: 'lead' }, { ...filters, community_id: 'c2' });
  assert.equal(crossCommunity.response.status, 403);
  assert.equal(crossCommunity.body.code, 'REPORT_SCOPE_FORBIDDEN');
  const badDate = await post(3, { id: 1, role: 'lead' }, { ...filters, from: '2026-09-01' });
  assert.equal(badDate.response.status, 400);
  assert.equal(badDate.body.code, 'INVALID_DATE_RANGE');
});

test('AI 未配置时返回稳定 503，状态接口不暴露密钥和地址', async (t) => {
  const db = await fixture();
  const config = enabledConfig();
  config.AI_API_KEY = '';
  const server = await startHttpServer(db, appOptions(config));
  t.after(() => { db.close(); return server.close(); });
  const headers = { ...authHeader({ id: 3, role: 'worker' }), 'Content-Type': 'application/json' };
  const status = await jsonRequest(server, '/api/reports/ai/status', { headers });
  assert.deepEqual(status.body.data, { enabled: false, model: 'qwen3.6-flash' });
  assert.equal(JSON.stringify(status.body).includes('AI_API_KEY'), false);
  assert.equal(JSON.stringify(status.body).includes('example.test'), false);

  const response = await jsonRequest(server, '/api/reports/staff/3/ai-analysis', {
    method: 'POST', headers,
    body: JSON.stringify({ from: '2026-08-01', to: '2026-08-31', community_id: 'c1' }),
  });
  assert.equal(response.response.status, 503);
  assert.equal(response.body.code, 'AI_REPORT_NOT_CONFIGURED');
});

test('单用户一分钟最多触发五次 AI 分析', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db, appOptions());
  t.after(() => { db.close(); return server.close(); });
  const request = () => jsonRequest(server, '/api/reports/staff/3/ai-analysis', {
    method: 'POST',
    headers: { ...authHeader({ id: 3, role: 'worker' }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '2026-08-01', to: '2026-08-31', community_id: 'c1' }),
  });
  for (let index = 0; index < 5; index += 1) assert.equal((await request()).response.status, 200);
  const sixth = await request();
  assert.equal(sixth.response.status, 429);
  assert.equal(sixth.body.code, 'AI_REPORT_RATE_LIMITED');
});
