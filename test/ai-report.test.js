const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../workforce-schema');

const {
  sanitizeReport,
  buildMessages,
  cleanAnalysis,
  reportHash,
  mapProviderError,
  analyzeReport,
} = require('../services/ai-report');

function reportFixture() {
  return {
    staff: {
      id: 27,
      user_id: 99,
      name: '张师傅',
      phone: '13800138000',
      position: '维修师傅',
      birth_month: '1988-06',
      join_date: '2024-01-02',
    },
    range: {
      from: '2026-07-31T16:00:00.000Z',
      toExclusive: '2026-08-31T16:00:00.000Z',
    },
    received: { total: 12, basis: 'assigned_at_or_created' },
    completed: { total: 10, averageHours: 3.2, onTimeRate: 90 },
    current: { doing: 1, pending: 1, waiting: 0, returned: 1 },
    recurrence: { total: 2 },
    feedback: { multiple: 1 },
    categories: [
      { category: '水暖', total: 7, ticket_id: 'secret-ticket-id' },
      { category: '电路', total: 5 },
    ],
    performance: {
      status: 'scored',
      score: 86.5,
      level: 'good',
      sampleSize: 10,
      components: {
        completion: { score: 83.3, contribution: 25 },
        onTime: { score: 90, contribution: 45 },
        quality: { score: 82.5, contribution: 16.5 },
      },
      ruleVersions: [{ version: 2, sampleSize: 10, internalId: 456 }],
    },
    rawTickets: [{ desc: '3号楼李女士电话 13900001111', loc: '3-1-202' }],
  };
}

test('模型输入只保留聚合数据并移除人员和工单敏感字段', () => {
  const payload = sanitizeReport(reportFixture(), {
    from: '2026-08-01',
    to: '2026-08-31',
    community_id: 'secret-community-id',
    community_name: '幸福家园',
  });

  assert.equal(payload.staff.role, '维修师傅');
  assert.equal(payload.period.from, '2026-08-01');
  assert.equal(payload.scope, '所选小区');
  assert.deepEqual(payload.categories, [
    { category: '水暖', total: 7 },
    { category: '电路', total: 5 },
  ]);
  const serialized = JSON.stringify(payload);
  for (const secret of [
    '张师傅', '13800138000', 'secret-community-id', '幸福家园',
    'secret-ticket-id', '3号楼', '13900001111', '3-1-202', 'internalId',
  ]) {
    assert.equal(serialized.includes(secret), false, `leaked: ${secret}`);
  }
});

test('自定义职位即使夹带个人信息也只映射为固定岗位枚举', () => {
  const report = reportFixture();
  report.staff.position = '张师傅-水暖维修-13800138000';
  const payload = sanitizeReport(report, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(payload.staff.role, '维修师傅');
  assert.equal(JSON.stringify(payload).includes('张师傅'), false);
  assert.equal(JSON.stringify(payload).includes('13800138000'), false);
});

test('提示词明确要求正式润色、保持数字并输出六段式 JSON', () => {
  const messages = buildMessages(sanitizeReport(reportFixture(), {
    from: '2026-08-01', to: '2026-08-31',
  }));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /正式、清晰、可直接用于管理汇报/);
  assert.match(messages[0].content, /不得修改或编造数字/);
  assert.match(messages[0].content, /数据不足以判断/);
  for (const field of ['summary', 'highlights', 'issues', 'trends', 'risks', 'recommendations']) {
    assert.match(messages[0].content, new RegExp(field));
  }
  assert.match(messages[1].content, /86\.5/);
});

test('模型输出只保留六字段并清除 HTML、控制字符和超长内容', () => {
  const cleaned = cleanAnalysis({
    summary: '<script>alert(1)</script><b>整体稳定</b>\u0000' + '结'.repeat(700),
    highlights: ['<b>完成率高</b>', ...Array.from({ length: 8 }, (_, index) => `亮点${index}`)],
    issues: '不是数组',
    trends: ['时长趋稳'],
    risks: ['<img src=x onerror=alert(1)>复发风险'],
    recommendations: ['专项巡检' + '查'.repeat(250)],
    html: '<p>unknown</p>',
  });

  assert.deepEqual(Object.keys(cleaned).sort(), [
    'highlights', 'issues', 'recommendations', 'risks', 'summary', 'trends',
  ]);
  assert.equal(cleaned.summary.includes('<'), false);
  assert.equal(cleaned.summary.includes('\u0000'), false);
  assert.equal(cleaned.summary.length, 600);
  assert.equal(cleaned.highlights.length, 6);
  assert.deepEqual(cleaned.issues, []);
  assert.equal(cleaned.risks[0], '复发风险');
  assert.equal(cleaned.recommendations[0].length, 200);
});

test('报告哈希稳定区分模型与提示词版本', () => {
  const payload = sanitizeReport(reportFixture(), { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(reportHash(payload, 'qwen3.6-flash', 'v1'), reportHash(payload, 'qwen3.6-flash', 'v1'));
  assert.notEqual(reportHash(payload, 'qwen3.6-flash', 'v1'), reportHash(payload, 'qwen3.6-flash', 'v2'));
  assert.match(reportHash(payload, 'qwen3.6-flash', 'v1'), /^[a-f0-9]{64}$/);
});

test('供应商状态映射为稳定且不泄露原始响应的错误', () => {
  assert.equal(mapProviderError(401, { message: 'secret upstream body' }).code, 'AI_REPORT_PROVIDER_ERROR');
  assert.equal(mapProviderError(429, {}).code, 'AI_REPORT_RATE_LIMITED');
  assert.equal(mapProviderError(400, { code: 'Arrearage' }).code, 'AI_REPORT_QUOTA_EXHAUSTED');
  assert.equal(mapProviderError(503, {}).status, 502);
  assert.doesNotMatch(mapProviderError(401, { message: 'secret upstream body' }).message, /secret upstream body/);
});

async function cacheFixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE tickets (id TEXT PRIMARY KEY)');
  ensureWorkforceSchema(db);
  return db;
}

function aiConfig(overrides = {}) {
  return {
    AI_REPORT_ENABLED: true,
    AI_BASE_URL: 'https://example.test/compatible-mode/v1',
    AI_API_KEY: 'server-only-key',
    AI_MODEL: 'qwen3.6-flash',
    AI_TIMEOUT_MS: 100,
    AI_REPORT_PROMPT_VERSION: 'report-analysis-v1',
    ...overrides,
  };
}

function providerResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('千问成功响应写入缓存，相同报告第二次不再消耗调用额度', async (t) => {
  const db = await cacheFixture();
  t.after(() => db.close());
  let calls = 0;
  let persisted = 0;
  let captured;
  const fetchImpl = async (url, options) => {
    calls += 1;
    captured = { url, options, body: JSON.parse(options.body) };
    return providerResponse(200, {
      choices: [{ message: { content: JSON.stringify({
        summary: '本期整体表现稳定。',
        highlights: ['按时率保持较高水平'],
        issues: ['存在少量复发工单'],
        trends: ['处理时长总体平稳'],
        risks: ['复发问题可能影响满意度'],
        recommendations: ['对水暖点位开展专项巡检'],
      }) } }],
    });
  };
  const options = {
    db,
    report: reportFixture(),
    filters: { from: '2026-08-01', to: '2026-08-31', community_id: 'default' },
    staffProfileId: 27,
    actorUserId: 1,
    config: aiConfig(),
    fetchImpl,
    persist: async () => { persisted += 1; },
  };

  const first = await analyzeReport(options);
  const second = await analyzeReport({
    ...options,
    fetchImpl: async () => { throw new Error('cache miss'); },
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.analysis.summary, '本期整体表现稳定。');
  assert.equal(calls, 1);
  assert.equal(persisted, 1);
  assert.equal(captured.url, 'https://example.test/compatible-mode/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer server-only-key');
  assert.equal(captured.body.model, 'qwen3.6-flash');
  assert.deepEqual(captured.body.response_format, { type: 'json_object' });
  assert.equal(JSON.stringify(captured.body).includes('张师傅'), false);
  const stored = db.exec('SELECT analysis_json FROM ai_report_analyses');
  assert.equal(JSON.stringify(stored).includes('server-only-key'), false);
});

test('未配置 AI 时立即返回 503 且不会调用供应商', async (t) => {
  const db = await cacheFixture();
  t.after(() => db.close());
  await assert.rejects(() => analyzeReport({
    db,
    report: reportFixture(),
    filters: { from: '2026-08-01', to: '2026-08-31' },
    staffProfileId: 27,
    actorUserId: 1,
    config: aiConfig({ AI_API_KEY: '' }),
    fetchImpl: async () => { throw new Error('must not call'); },
  }), (error) => error.status === 503 && error.code === 'AI_REPORT_NOT_CONFIGURED');
});

test('429 和 5xx 只重试一次，额度耗尽与无效 JSON 不重试', async (t) => {
  const db = await cacheFixture();
  t.after(() => db.close());
  let retryCalls = 0;
  const retried = await analyzeReport({
    db,
    report: reportFixture(),
    filters: { from: '2026-08-01', to: '2026-08-31' },
    staffProfileId: 27,
    actorUserId: 1,
    config: aiConfig(),
    fetchImpl: async () => {
      retryCalls += 1;
      if (retryCalls === 1) return providerResponse(503, {});
      return providerResponse(200, { choices: [{ message: { content: JSON.stringify({
        summary: '重试后成功', highlights: [], issues: [], trends: [], risks: [], recommendations: [],
      }) } }] });
    },
  });
  assert.equal(retried.analysis.summary, '重试后成功');
  assert.equal(retryCalls, 2);

  let quotaCalls = 0;
  await assert.rejects(() => analyzeReport({
    db,
    report: reportFixture(),
    filters: { from: '2026-09-01', to: '2026-09-30' },
    staffProfileId: 27,
    actorUserId: 1,
    config: aiConfig(),
    fetchImpl: async () => {
      quotaCalls += 1;
      return providerResponse(400, { code: 'Arrearage', message: 'private provider detail' });
    },
  }), (error) => error.code === 'AI_REPORT_QUOTA_EXHAUSTED'
      && !error.message.includes('private provider detail'));
  assert.equal(quotaCalls, 1);

  let invalidCalls = 0;
  await assert.rejects(() => analyzeReport({
    db,
    report: reportFixture(),
    filters: { from: '2026-10-01', to: '2026-10-31' },
    staffProfileId: 27,
    actorUserId: 1,
    config: aiConfig(),
    fetchImpl: async () => {
      invalidCalls += 1;
      return providerResponse(200, { choices: [{ message: { content: 'not json' } }] });
    },
  }), (error) => error.code === 'AI_REPORT_INVALID_RESPONSE');
  assert.equal(invalidCalls, 1);
});

test('超时返回稳定错误且不包含密钥', async (t) => {
  const db = await cacheFixture();
  t.after(() => db.close());
  await assert.rejects(() => analyzeReport({
    db,
    report: reportFixture(),
    filters: { from: '2026-11-01', to: '2026-11-30' },
    staffProfileId: 27,
    actorUserId: 1,
    config: aiConfig({ AI_TIMEOUT_MS: 5 }),
    fetchImpl: async () => new Promise(() => {}),
  }), (error) => error.code === 'AI_REPORT_TIMEOUT'
      && error.status === 504
      && !error.message.includes('server-only-key'));
});
