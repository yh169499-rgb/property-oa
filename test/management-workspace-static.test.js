const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const myPage = fs.readFileSync(path.join(publicDir, 'js', 'my-page.js'), 'utf8');
const workspace = fs.readFileSync(
  path.join(publicDir, 'js', 'management-workspace.js'),
  'utf8'
);

test('legacy admin and schedule pages are not navigation targets', () => {
  assert.doesNotMatch(html, /id="page-admin"/);
  assert.doesNotMatch(html, /id="page-schedule"/);
  assert.doesNotMatch(html, /showPage\(['"]schedule/);
  assert.doesNotMatch(app, /#page-(?:admin|schedule)/);
});

test('management tabs create their own registration and settings mounts', () => {
  assert.match(workspace, /mount\.id = 'pending-reg-list'/);
  assert.match(workspace, /count\.id = 'pending-count'/);
  assert.match(workspace, /reminder-interval/);
  assert.match(workspace, /sla-interval/);
  assert.doesNotMatch(workspace, /appendChild\(legacy/);
  assert.doesNotMatch(workspace, /legacy-management-settings/);
});

test('schedule date and staff changes reload filtered assignments', () => {
  assert.match(workspace, /date\.addEventListener\('change', refresh\)/);
  assert.match(workspace, /staff\.addEventListener\('change', refresh\)/);
  assert.match(workspace, /staff_id=/);
});

test('management page keeps the blue hero as its only title and reports react to filters', () => {
  assert.doesNotMatch(html, /id="page-management"[\s\S]*?<div class="page-title">管理工作台<\/div>/);
  assert.match(workspace, /staff\.addEventListener\('change', generateReport\)/);
  assert.match(workspace, /community\.addEventListener\('change', generateReport\)/);
  assert.match(workspace, /from\.addEventListener\('change', generateReport\)/);
  assert.match(workspace, /to\.addEventListener\('change', generateReport\)/);
});

test('人员报告支持全部人员团队汇总', () => {
  assert.match(workspace, /全部人员/);
  assert.match(workspace, /value: 'all'/);
});

test('主管首页和我的页面不再渲染考勤模块', () => {
  assert.doesNotMatch(html, /团队到岗|考勤异常|dashboard-attendance/);
  assert.doesNotMatch(app, /renderDashboardAttendanceDetails|dashboard-team-attendance|dashboard-attendance/);
  assert.doesNotMatch(myPage, /本月实际考勤|考勤 ·|my-attendance-panel|\/api\/me\/attendance|团队迟到/);
});

test('主管导航和注册审核页签会显示待审核红点并定时刷新', () => {
  assert.match(app, /function updatePendingRegistrationBadge\s*\(/);
  assert.match(app, /\.nav button\[data-page="management"\]/);
  assert.match(app, /\.management-tab\[data-tab="registrations"\]/);
  assert.match(app, /pending_count/);
  assert.match(app, /loadPendingRegistrations\(\)/);
});
