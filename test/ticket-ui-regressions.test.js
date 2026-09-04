const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

test('导航红点统计全部未完结工单而非仅待派单', () => {
  const block = source.slice(source.indexOf('function updateNavBadges()'), source.indexOf('function renderDone()'));
  assert.match(block, /t\.status\s*===\s*['"]done['"]/);
  assert.doesNotMatch(block, /t\.status\s*!==\s*['"]wait['"]/);
});

test('提醒设置读写请求均携带认证头', () => {
  const block = source.slice(source.indexOf('function saveReminderInterval()'), source.indexOf('function renderAdminProfile()'));
  assert.match(block, /settings\/reminder[\s\S]*headers:authHeaders\(true\)/);
  assert.match(block, /settings\/sla[\s\S]*headers:authHeaders\(true\)/);
});

test('现场材料分离拍照和上传并通过认证 Blob 加载', () => {
  assert.match(source, /function capturePhoto\(/);
  assert.match(source, /capture\s*=\s*['"]environment['"]/);
  assert.match(source, /URL\.createObjectURL/);
  assert.match(source, /fetch\([^\n]+url[^\n]+headers:\s*authHeaders\(\)/);
  assert.match(source, />拍照</);
  assert.match(source, />上传照片</);
});

