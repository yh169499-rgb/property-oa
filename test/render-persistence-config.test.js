const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderYaml = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('Render 使用持久化磁盘保存生产数据库', () => {
  assert.match(renderYaml, /key:\s*DB_PATH[\s\S]*?value:\s*\/var\/data\/data\.db/);
  assert.match(renderYaml, /key:\s*UPLOAD_DIR[\s\S]*?value:\s*\/var\/data\/uploads/);
  assert.match(renderYaml, /disk:\s*\n\s+name:\s*property-oa-data/);
  assert.match(renderYaml, /mountPath:\s*\/var\/data/);
  assert.match(renderYaml, /sizeGB:\s*1/);
});

test('Render 声明千问报告配置但不把 API Key 写入仓库', () => {
  assert.match(renderYaml, /key:\s*AI_REPORT_ENABLED/);
  assert.match(renderYaml, /key:\s*AI_BASE_URL[\s\S]*dashscope\.aliyuncs\.com\/compatible-mode\/v1/);
  assert.match(renderYaml, /key:\s*AI_MODEL[\s\S]*qwen3\.6-flash/);
  assert.match(renderYaml, /key:\s*AI_API_KEY\s*\n\s+sync:\s*false/);
  assert.doesNotMatch(renderYaml, /AI_API_KEY[\s\S]{0,80}value:/);
  assert.match(readme, /AI 优化并润色/);
  assert.match(readme, /免费额度用完即停/);
  assert.match(readme, /`AI_REPORT_ENABLED`[\s\S]{0,80}控制 AI 报告润色是否启用/);
  assert.doesNotMatch(readme, /\b[A-Z][A-Z0-9_]*(?:SECRET|KEY|PASSWORD|TOKEN)[A-Z0-9_]*\s*=\s*\S+/);
});
