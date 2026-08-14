const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const source = fs.readFileSync('public/js/management-workspace.js', 'utf8');
const calendarSource = fs.readFileSync('public/js/responsive-calendar.js', 'utf8');

test('settings workspace exposes shift template CRUD controls', () => {
  assert.match(source, /班次模板/);
  assert.match(source, /新增模板/);
  assert.match(source, /编辑模板/);
  assert.match(source, /删除模板/);
  assert.match(source, /POST.*\/api\/shift-templates|\/api\/shift-templates'.*POST/s);
  assert.match(source, /PATCH.*\/api\/shift-templates|\/api\/shift-templates\/'.*PATCH/s);
  assert.match(source, /DELETE.*\/api\/shift-templates|\/api\/shift-templates\/'.*DELETE/s);
  assert.match(source, /SHIFT_TEMPLATE_IN_USE/);
});

test('主管日历 exposes a delete action for existing attendance records', () => {
  assert.match(calendarSource, /删除考勤记录/);
  assert.match(source, /\/api\/attendance\//);
  assert.match(source, /method:\s*'DELETE'/);
});

test('批量排班打开时重新读取模板，避免新增模板后仍显示旧列表', () => {
  assert.match(source, /batch\.addEventListener\('click',\s*async/);
  assert.match(source, /var latestTemplates = await request\('\/api\/shift-templates'\)/);
  assert.match(source, /latestTemplates\.map\(function \(item\)/);
});

test('主管工作台把实际状态放进日历，不再生成独立考勤页签', () => {
  assert.match(source, /var MANAGEMENT_TABS = \[\s*'organization', 'schedule', 'registrations', 'reports', 'settings'/);
  assert.doesNotMatch(source, /if \(tab === 'attendance'\)/);
  assert.match(source, /ResponsiveCalendar\.render\(calendar, calendarData \|\| \{\}, \{[\s\S]*onDeleteAttendance/);
  assert.match(calendarSource, /删除考勤记录/);
});

test('日历展示请假与冲突状态', () => {
  const calendar = fs.readFileSync('public/js/responsive-calendar.js', 'utf8');
  assert.match(calendar, /请假|休息|未排班/);
  assert.match(calendar, /冲突|conflict/);
  assert.match(calendar, /attendanceStatusLabel/);
  assert.match(calendar, /shanghaiTime/);
  assert.match(calendar, /工单.*时间重叠/);
  assert.match(calendar, /班次内可派单/);
});
