const test = require('node:test');
const assert = require('node:assert/strict');

test('显式环境变量优先于 .env 文件', () => {
  const modulePath = require.resolve('../config');
  const previous = process.env.PORT;
  process.env.PORT = '59170';
  delete require.cache[modulePath];
  try {
    assert.equal(require('../config').PORT, '59170');
  } finally {
    if (previous === undefined) delete process.env.PORT;
    else process.env.PORT = previous;
    delete require.cache[modulePath];
  }
});

test('敏感配置缺省时不使用仓库内的真实凭据', () => {
  const modulePath = require.resolve('../config');
  const previousJwt = process.env.JWT_SECRET;
  const previousMsgToken = process.env.JZMM_MSG_TOKEN;
  delete process.env.JWT_SECRET;
  delete process.env.JZMM_MSG_TOKEN;
  delete require.cache[modulePath];
  try {
    const config = require('../config');
    assert.equal(config.JWT_SECRET, 'local-development-only');
    assert.equal(config.JZMM_MSG_TOKEN, '');
  } finally {
    if (previousJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwt;
    if (previousMsgToken === undefined) delete process.env.JZMM_MSG_TOKEN;
    else process.env.JZMM_MSG_TOKEN = previousMsgToken;
    delete require.cache[modulePath];
  }
});

test('AI 报告配置读取千问兼容接口且超时值有安全默认', () => {
  const modulePath = require.resolve('../config');
  const names = [
    'AI_REPORT_ENABLED', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
    'AI_TIMEOUT_MS', 'AI_REPORT_PROMPT_VERSION',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    AI_REPORT_ENABLED: 'true',
    AI_BASE_URL: 'https://example.test/compatible-mode/v1/',
    AI_API_KEY: 'test-only-key',
    AI_MODEL: 'qwen3.6-flash',
    AI_TIMEOUT_MS: '-1',
    AI_REPORT_PROMPT_VERSION: 'report-analysis-v2',
  });
  delete require.cache[modulePath];
  try {
    const config = require('../config');
    assert.equal(config.AI_REPORT_ENABLED, true);
    assert.equal(config.AI_BASE_URL, 'https://example.test/compatible-mode/v1');
    assert.equal(config.AI_API_KEY, 'test-only-key');
    assert.equal(config.AI_MODEL, 'qwen3.6-flash');
    assert.equal(config.AI_TIMEOUT_MS, 30000);
    assert.equal(config.AI_REPORT_PROMPT_VERSION, 'report-analysis-v2');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    delete require.cache[modulePath];
  }
});
