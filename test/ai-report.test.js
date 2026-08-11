const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeReport,
  buildMessages,
  cleanAnalysis,
  reportHash,
  mapProviderError,
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
