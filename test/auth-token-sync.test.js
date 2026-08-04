const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('登录成功后必须同步更新 API 内存 token', () => {
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const loginBlock = source.slice(source.indexOf('function doLogin()'), source.indexOf('function showRegisterForm()'));

  assert.match(loginBlock, /API\.setToken\(d\.token\)/);
  assert.doesNotMatch(loginBlock, /localStorage\.setItem\(['"]auth_token['"],\s*d\.token\)/);
});
