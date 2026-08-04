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
