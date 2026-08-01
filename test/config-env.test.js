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
