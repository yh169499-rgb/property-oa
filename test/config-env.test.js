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
