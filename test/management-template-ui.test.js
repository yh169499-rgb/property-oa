const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const source = fs.readFileSync('public/js/management-workspace.js', 'utf8');

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

test('attendance workspace exposes a delete action for existing records', () => {
  assert.match(source, /删除记录/);
  assert.match(source, /\/api\/attendance\//);
  assert.match(source, /method:\s*'DELETE'/);
});

test('批量排班打开时重新读取模板，避免新增模板后仍显示旧列表', () => {
  assert.match(source, /batch\.addEventListener\('click',\s*async/);
  assert.match(source, /var latestTemplates = await request\('\/api\/shift-templates'\)/);
  assert.match(source, /latestTemplates\.map\(function \(item\)/);
});
