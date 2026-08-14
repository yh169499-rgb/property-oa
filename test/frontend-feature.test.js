const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'public');
const workspace = fs.readFileSync(path.join(root, 'js', 'management-workspace.js'), 'utf8');
const report = fs.readFileSync(path.join(root, 'js', 'staff-report.js'), 'utf8');
const myPage = fs.readFileSync(path.join(root, 'js', 'my-page.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'js', 'api.js'), 'utf8');
const workerHome = fs.readFileSync(path.join(root, 'js', 'worker-home.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const workforceApi = fs.readFileSync(path.join(root, 'js', 'workforce-api.js'), 'utf8');

test('设置页提供服务端绩效规则读取和发布入口', () => {
  assert.match(workspace, /\/api\/settings\/performance/);
  assert.match(workspace, /performance_weight|completion_weight|on_time_weight/);
  assert.match(workspace, /performance\/versions/);
});

test('认证信息按浏览器标签页隔离，避免多账号互相顶掉登录', () => {
  assert.match(api, /sessionStorage\.getItem\(['"]auth_token['"]\)/);
  assert.match(api, /sessionStorage\.setItem\(['"]auth_token['"]\s*[,)]/);
  assert.match(api, /sessionStorage\.removeItem\(['"]auth_token['"]\)/);
  assert.doesNotMatch(api, /localStorage\.(?:getItem|setItem|removeItem)\(['"]auth_token['"]\)/);
  assert.doesNotMatch(app, /localStorage\.(?:getItem|setItem|removeItem)\(['"](?:auth_token|login_user)['"]\)/);
  assert.doesNotMatch(workspace, /localStorage\.getItem\(['"]auth_token['"]\)/);
  assert.match(app, /remembered_auth_sessions/);
  assert.match(app, /API\.clearToken\(\)/);
});

test('员工页面从同小区通讯录读取手机号', () => {
  assert.match(myPage, /\/api\/staff\/directory/);
  assert.match(workerHome, /\/api\/staff\/directory/);
  assert.match(myPage + workerHome, /通讯录|同事/);
});

test('维修师傅和物业管家都保留报修、投诉、帮助三个工单入口', () => {
  assert.match(app, /b\.dataset\.page === 'complaint' \|\| b\.dataset\.page === 'help'/);
  assert.doesNotMatch(app, /b\.dataset\.page === 'repair'[^\n]*isKeeper \? 'none'/);
  assert.match(workerHome, /我的工单/);
  assert.match(workerHome, /报修工单/);
  assert.match(workerHome, /投诉工单/);
  assert.match(workerHome, /帮助工单/);
  assert.match(workerHome, /page: 'repair'/);
  assert.match(workerHome, /page: 'complaint'/);
  assert.match(workerHome, /page: 'help'/);
  assert.match(workerHome, /navTo\(entry\.page\)/);
});

test('主管派单等待服务端成功并提交预计工时，失败时不显示虚假成功', () => {
  const assignSource = app.slice(app.indexOf('async function assignTicket(id)'), app.indexOf('function checkAssignConflicts'));
  assert.match(app, /async function assignTicket\(id\)/);
  assert.match(app, /await apiPatch\(t\.id,\{status:'doing',worker:workerName,estimated_hours:estHours\}\)/);
  assert.match(app, /if\(!result\.ok\)/);
  assert.match(app, /result\.error/);
  assert.doesNotMatch(app, /确定仍要派单/);
  assert.doesNotMatch(assignSource, /checkAssignConflicts/);
  assert.match(app, /state\.dispatchCalendar/);
  assert.match(app, /await loadDispatchCalendar\(\)/);
  assert.match(app, /person\.accountRole === 'worker'/);
  assert.match(app, /person\.shifts/);
  assert.match(app, /endMs <= Date\.parse\(shift\.endAt\)/);
  const activeSource = app.slice(app.indexOf('function activeStaff(role'), app.indexOf('function parseHM'));
  assert.doesNotMatch(activeSource, /s\.status|dutyStart|dutyEnd/);
  assert.match(app, /onchange="refreshAssignWorkers/);
  assert.match(app, /function refreshAssignWorkers/);
});

test('日历前端支持同一天展示多个可派班次窗口', () => {
  assert.match(workerHome, /person\.shifts/);
  assert.match(myPage, /ownCalendar\.shifts/);
  assert.match(fs.readFileSync(path.join(root, 'js', 'responsive-calendar.js'), 'utf8'), /person\.shifts/);
});

test('报告展示服务端绩效依据且不再展示考勤', () => {
  assert.match(report, /performance/);
  assert.match(report, /staff-report-performance/);
  assert.match(report, /综合得分/);
  assert.match(report, /完成率/);
  assert.match(report, /准时率/);
  assert.match(report, /质量分/);
  assert.match(report, /规则版本|样本/);
  assert.doesNotMatch(report, /实际考勤|考勤|attendance|接单口径|完成口径/);
});

test('每个人都能在我的页面看到服务端计算的本人绩效', () => {
  assert.match(myPage, /我的绩效/);
  assert.match(myPage, /stats\.performance|personalResults\.performance/);
  assert.match(myPage, /完成率/);
  assert.match(myPage, /准时率/);
  assert.match(myPage, /质量分/);
  assert.doesNotMatch(myPage, /实际考勤|考勤记录|attendance/);
});

test('旧前端本地绩效公式不再作为数据源', () => {
  assert.doesNotMatch(app, /function performanceScore\s*\(/);
  assert.doesNotMatch(app, /m\.onRate\s*\*\s*\.7/);
});

test('人员报告提供按需千问润色并固定展示六类管理解读', () => {
  assert.match(report, /AI 优化并润色/);
  assert.match(report, /AI 润色报告/);
  assert.match(report, /整体总结/);
  assert.match(report, /工作亮点/);
  assert.match(report, /主要问题/);
  assert.match(report, /趋势判断/);
  assert.match(report, /风险提醒/);
  assert.match(report, /后续建议/);
  assert.match(report, /AI 建议，仅供管理参考/);
  assert.match(workforceApi, /ai-analysis/);
  assert.match(workforceApi, /reports\/staff\/all\/ai-analysis/);
  assert.match(workforceApi, /reports\/ai\/status/);
  assert.doesNotMatch(report, /analysis\.summary[^\n]*innerHTML/);
});
