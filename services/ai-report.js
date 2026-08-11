const crypto = require('node:crypto');
const defaultFetch = require('node-fetch');

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

function safeRoleLabel(value) {
  const role = String(value || '');
  if (/主管|经理|管理/.test(role)) return '主管';
  if (/管家/.test(role)) return '物业管家';
  if (/维修|师傅|技工/.test(role)) return '维修师傅';
  return '员工';
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
    staff: { role: safeRoleLabel(staff.position) },
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
    const error = aiError(429, 'AI_REPORT_RATE_LIMITED', 'AI 报告请求过于频繁，请稍后再试');
    error.retryable = true;
    return error;
  }
  const error = aiError(502, 'AI_REPORT_PROVIDER_ERROR', 'AI 服务暂时不可用，原始报告不受影响');
  error.retryable = Number(status) >= 500;
  return error;
}

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function configured(config) {
  return Boolean(config && config.AI_REPORT_ENABLED && config.AI_API_KEY
    && config.AI_BASE_URL && config.AI_MODEL);
}

function parseAnalysisContent(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  const text = String(content || '').trim();
  if (!text) throw aiError(502, 'AI_REPORT_INVALID_RESPONSE', 'AI 返回内容无效，原始报告不受影响');
  try {
    return JSON.parse(text);
  } catch (_) {
    const repaired = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(repaired);
    } catch (_) {
      throw aiError(502, 'AI_REPORT_INVALID_RESPONSE', 'AI 返回内容无效，原始报告不受影响');
    }
  }
}

function validateAnalysisShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.summary !== 'string'
      || !ANALYSIS_FIELDS.slice(1).every((field) => Array.isArray(input[field]))) {
    throw aiError(502, 'AI_REPORT_INVALID_RESPONSE', 'AI 返回内容无效，原始报告不受影响');
  }
  const cleaned = cleanAnalysis(input);
  if (!cleaned.summary) {
    throw aiError(502, 'AI_REPORT_INVALID_RESPONSE', 'AI 返回内容无效，原始报告不受影响');
  }
  return cleaned;
}

function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(aiError(504, 'AI_REPORT_TIMEOUT', 'AI 生成超时，原始报告不受影响'));
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function providerAttempt(config, payload, fetchImpl) {
  let response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${config.AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.AI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.AI_MODEL,
          messages: buildMessages(payload),
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 1800,
        }),
      },
      Number(config.AI_TIMEOUT_MS) || 30000
    );
  } catch (error) {
    if (error && error.code === 'AI_REPORT_TIMEOUT') throw error;
    const networkError = aiError(502, 'AI_REPORT_PROVIDER_ERROR', 'AI 服务暂时不可用，原始报告不受影响');
    networkError.retryable = true;
    throw networkError;
  }
  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    if (response.ok) throw aiError(502, 'AI_REPORT_INVALID_RESPONSE', 'AI 返回内容无效，原始报告不受影响');
  }
  if (!response.ok) throw mapProviderError(response.status, body);
  const content = body && body.choices && body.choices[0]
    && body.choices[0].message && body.choices[0].message.content;
  return validateAnalysisShape(parseAnalysisContent(content));
}

async function callProvider(config, payload, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await providerAttempt(config, payload, fetchImpl);
    } catch (error) {
      if (!error.retryable || attempt === 1) throw error;
    }
  }
  throw aiError(502, 'AI_REPORT_PROVIDER_ERROR', 'AI 服务暂时不可用，原始报告不受影响');
}

async function analyzeReport(options = {}) {
  const {
    db,
    report,
    filters = {},
    staffProfileId,
    actorUserId,
    config,
    fetchImpl = defaultFetch,
    persist = async () => {},
  } = options;
  if (!configured(config)) {
    throw aiError(503, 'AI_REPORT_NOT_CONFIGURED', 'AI 报告尚未配置，原始报告仍可正常使用');
  }
  const payload = sanitizeReport(report, filters);
  const hash = reportHash(payload, config.AI_MODEL, config.AI_REPORT_PROMPT_VERSION);
  const cached = rows(db, `
    SELECT analysis_json, created_at
      FROM ai_report_analyses
     WHERE report_hash = ? AND model = ? AND prompt_version = ?
     LIMIT 1`,
  [hash, config.AI_MODEL, config.AI_REPORT_PROMPT_VERSION])[0];
  if (cached) {
    try {
      return {
        status: 'ready',
        cached: true,
        model: config.AI_MODEL,
        promptVersion: config.AI_REPORT_PROMPT_VERSION,
        analysis: validateAnalysisShape(JSON.parse(cached.analysis_json)),
        createdAt: cached.created_at,
      };
    } catch (_) {
      db.run(`DELETE FROM ai_report_analyses
        WHERE report_hash = ? AND model = ? AND prompt_version = ?`,
      [hash, config.AI_MODEL, config.AI_REPORT_PROMPT_VERSION]);
    }
  }

  const analysis = await callProvider(config, payload, fetchImpl);
  const createdAt = new Date().toISOString();
  db.run(`INSERT OR REPLACE INTO ai_report_analyses (
      staff_profile_id, community_id, range_from, range_to, report_hash,
      model, prompt_version, analysis_json, created_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    Number(staffProfileId),
    String(filters.community_id || filters.communityId || ''),
    String(filters.from || ''),
    String(filters.to || ''),
    hash,
    config.AI_MODEL,
    config.AI_REPORT_PROMPT_VERSION,
    JSON.stringify(analysis),
    Number(actorUserId) || null,
    createdAt,
  ]);
  await persist();
  return {
    status: 'ready',
    cached: false,
    model: config.AI_MODEL,
    promptVersion: config.AI_REPORT_PROMPT_VERSION,
    analysis,
    createdAt,
  };
}

module.exports = {
  ANALYSIS_FIELDS,
  sanitizeReport,
  buildMessages,
  cleanAnalysis,
  reportHash,
  mapProviderError,
  configured,
  analyzeReport,
};
