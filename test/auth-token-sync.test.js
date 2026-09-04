const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('登录成功后必须同步更新 API 内存 token', () => {
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const loginBlock = source.slice(source.indexOf('function doLogin()'), source.indexOf('function showRegisterForm()'));

  assert.match(loginBlock, /API\.setToken\(d\.token\)/);
  assert.doesNotMatch(loginBlock, /localStorage\.setItem\(['"]auth_token['"],\s*d\.token\)/);
});

test('业务登录凭据只使用页签级 sessionStorage，避免多企业账号串号', () => {
  const appSource = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const apiSource = fs.readFileSync(require.resolve('../public/js/api.js'), 'utf8');

  assert.match(appSource, /sessionStorage\.setItem\('login_user'/);
  assert.match(apiSource, /sessionStorage\.getItem\('auth_token'/);
  assert.doesNotMatch(appSource, /localStorage\.setItem\('login_user'/);
  assert.doesNotMatch(apiSource, /localStorage\.setItem\('auth_token'/);
});
