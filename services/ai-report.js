const crypto = require('node:crypto');

const ANALYSIS_FIELDS = [
  'summary', 'highlights', 'issues', 'trends', 'risks', 'recommendations',
];

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function scoreComponent(performance, key) {
  const component = performance && performance.components && performance.components[key] || {};
  return {
    score: component.score == null ? null : number(component.score),
    contribution: component.contribution == null ? null : number(component.contribution),
  };
}

function sanitizeReport(report = {}, filters = {}) {
  const staff = report.staff || {};
  const completed = report.completed || {};
  const current = report.current || {};
  const performance = report.performance || {};
  return {
    period: {
      from: String(filters.from || '').slice(0, 10),
      to: String(filters.to || '').slice(0, 10),
    },
    scope: '所选小区',
    staff: { role: String(staff.position || '员工').slice(0, 40) },
    workOrders: {
      received: number(report.received && report.received.total),
      completed: number(completed.total),
      averageHours: number(completed.averageHours),
      onTimeRate: number(completed.onTimeRate),
      doing: number(current.doing),
      pending: number(current.pending),
      waiting: number(current.waiting),
      returned: number(current.returned),
      recurring: number(report.recurrence && report.recurrence.total),
      multipleFeedback: number(report.feedback && report.feedback.multiple),
    },
    categories: (Array.isArray(report.categories) ? report.categories : []).slice(0, 30).map((item) => ({
      category: String(item.category || '其他').slice(0, 40),
      total: number(item.total),
    })),
    performance: {
      status: String(performance.status || 'insufficient_sample'),
      score: performance.score == null ? null : number(performance.score),
      level: String(performance.level || 'insufficient_sample'),
      sampleSize: number(performance.sampleSize),
      components: {
        completion: scoreComponent(performance, 'completion'),
        onTime: scoreComponent(performance, 'onTime'),
        quality: scoreComponent(performance, 'quality'),
      },
      ruleVersions: (Array.isArray(performance.ruleVersions) ? performance.ruleVersions : [])
        .slice(0, 10)
        .map((item) => ({
          version: number(item.version == null ? item.version_no : item.version),
          sampleSize: number(item.sampleSize),
        })),
    },
  };
}

function buildMessages(payload) {
  const system = [
    '你是物业工单运营报告编辑。请把输入的确定性统计整理和润色为正式、清晰、可直接用于管理汇报的中文报告解读。',
    '必须保留事实，不得修改或编造数字、工单、人员评价、原因或法律结论。摘要采用先结论后依据的表达。',
    '亮点、问题、趋势、风险和建议都必须与输入数据直接对应；建议要具体、可执行。证据不足时写“数据不足以判断”。',
    '只返回 JSON 对象，不要 Markdown、HTML 或代码围栏。字段固定为：',
    '{"summary":"整体总结","highlights":["工作亮点"],"issues":["主要问题"],"trends":["趋势判断"],"risks":["风险提醒"],"recommendations":["后续建议"]}',
    'summary 最多 600 个中文字符；每个数组最多 6 项，每项最多 200 个中文字符。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请基于以下已脱敏数据生成六段式润色报告：\n${JSON.stringify(payload)}` },
  ];
}

function stripUnsafeText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((item) => stripUnsafeText(item, 200)).filter(Boolean);
}

function cleanAnalysis(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    summary: stripUnsafeText(source.summary, 600),
    highlights: cleanList(source.highlights),
    issues: cleanList(source.issues),
    trends: cleanList(source.trends),
    risks: cleanList(source.risks),
    recommendations: cleanList(source.recommendations),
  };
}

function reportHash(payload, model, promptVersion) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ payload, model, promptVersion }))
    .digest('hex');
}

function aiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function mapProviderError(status, body = {}) {
  const upstreamCode = String(body.code || body.error && body.error.code || '').toLowerCase();
  const upstreamMessage = String(body.message || body.error && body.error.message || '').toLowerCase();
  if (/arrearage|quota|insufficient|balance/.test(`${upstreamCode} ${upstreamMessage}`)) {
    return aiError(503, 'AI_REPORT_QUOTA_EXHAUSTED', 'AI 免费额度已用完，原始报告仍可正常使用');
  }
  if (Number(status) === 429) {
    return aiError(429, 'AI_REPORT_RATE_LIMITED', 'AI 报告请求过于频繁，请稍后再试');
  }
  return aiError(502, 'AI_REPORT_PROVIDER_ERROR', 'AI 服务暂时不可用，原始报告不受影响');
}

module.exports = {
  ANALYSIS_FIELDS,
  sanitizeReport,
  buildMessages,
  cleanAnalysis,
  reportHash,
  mapProviderError,
};
