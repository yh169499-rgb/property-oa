const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'public');
const workspace = fs.readFileSync(path.join(root, 'js', 'management-workspace.js'), 'utf8');
const report = fs.readFileSync(path.join(root, 'js', 'staff-report.js'), 'utf8');
const myPage = fs.readFileSync(path.join(root, 'js', 'my-page.js'), 'utf8');
const workerHome = fs.readFileSync(path.join(root, 'js', 'worker-home.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('设置页提供服务端绩效规则读取和发布入口', () => {
  assert.match(workspace, /\/api\/settings\/performance/);
  assert.match(workspace, /performance_weight|completion_weight|on_time_weight/);
  assert.match(workspace, /performance\/versions/);
});

test('员工页面从同小区通讯录读取手机号', () => {
  assert.match(myPage, /\/api\/staff\/directory/);
  assert.match(workerHome, /\/api\/staff\/directory/);
  assert.match(myPage + workerHome, /通讯录|同事/);
});

test('报告展示服务端绩效依据且不再展示考勤', () => {
  assert.match(report, /performance/);
  assert.match(report, /计算依据|规则版本|样本/);
  assert.doesNotMatch(report, /考勤|attendance/);
});

test('旧前端本地绩效公式不再作为数据源', () => {
  assert.doesNotMatch(app, /function performanceScore\s*\(/);
  assert.doesNotMatch(app, /m\.onRate\s*\*\s*\.7/);
});
