const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderYaml = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');

test('Render 使用持久化磁盘保存生产数据库', () => {
  assert.match(renderYaml, /key:\s*DB_PATH[\s\S]*?value:\s*\/var\/data\/data\.db/);
  assert.match(renderYaml, /key:\s*UPLOAD_DIR[\s\S]*?value:\s*\/var\/data\/uploads/);
  assert.match(renderYaml, /disk:\s*\n\s+name:\s*property-oa-data/);
  assert.match(renderYaml, /mountPath:\s*\/var\/data/);
  assert.match(renderYaml, /sizeGB:\s*1/);
});