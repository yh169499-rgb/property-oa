const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const api = read('docs/API.md');
const security = read('docs/SECURITY-AUDIT.md');
const readme = read('README.md');
const introduction = read('介绍.md');
const render = read('render.yaml');
const documentation = [api, security, readme, introduction].join('\n');

function renderEnvBlock(key) {
  const match = render.match(new RegExp(`- key: ${key}\\n([\\s\\S]*?)(?=\\n\\s*- key:|$)`));
  assert.ok(match, `render.yaml 应声明 ${key}`);
  return match[1];
}

test('文档说明唯一平台运维和严格的企业边界', () => {
  assert.match(documentation, /platform_owner/);
  assert.match(documentation, /唯一平台运维/);
  assert.match(documentation, /每(?:个|家)企业(?:有且仅有|恰好)一名主管/);
  assert.match(documentation, /平台运维不能进入企业工单/);
  assert.match(documentation, /主管只能管理本企业/);
  assert.match(documentation, /staff_limit/);
  assert.match(documentation, /默认\s*4/);
  assert.match(documentation, /1\s*[–—~-]\s*999/);
  assert.match(documentation, /删除登录账号/);
  assert.match(documentation, /释放名额/);
  assert.match(documentation, /已离职/);
});

test('生产账号规划固定且不混入模拟数据', () => {
  assert.match(documentation, /13222514178[\s\S]{0,100}句子工单管理员/);
  assert.match(documentation, /13222514178[\s\S]{0,160}(?:不属于任何租户|tenant[^\n]{0,30}(?:为空|无))/i);
  assert.match(documentation, /13800000001[\s\S]{0,160}(?:保留既有模拟数据|保留原测试人员及全部\s*mock\s*数据)/i);
  assert.match(documentation, /17713302589[\s\S]{0,100}发财/);
  assert.match(documentation, /17713302589[\s\S]{0,180}(?:无\s*mock\s*数据|不写入\s*mock\s*数据)/i);
});

test('API 文档覆盖企业申请和平台维护端点', () => {
  for (const endpoint of [
    'POST /api/enterprise-applications',
    'POST /api/platform/login',
    'GET /api/platform/overview',
    'GET /api/platform/applications',
    'GET /api/platform/tenants',
    'GET /api/platform/audit-logs',
    'POST /api/platform/applications/:id/approve',
    'POST /api/platform/applications/:id/reject',
    'POST /api/platform/tenants/:id/disable',
    'POST /api/platform/tenants/:id/restore',
    'POST /api/platform/tenants/:id/reset-supervisor-password',
    'PATCH /api/platform/tenants/:id',
  ]) {
    assert.ok(api.includes(endpoint), `API 文档缺少 ${endpoint}`);
  }
  assert.match(api, /staffLimit[\s\S]{0,100}1\s*[–—~-]\s*999/);
  assert.match(api, /409[\s\S]{0,100}STAFF_LIMIT_BELOW_ACTIVE_COUNT/);
  assert.match(api, /服务端注入\s*`?tenant_id`?/);
  assert.match(api, /跨租户详情[\s\S]{0,60}404/);
  assert.match(api, /列表[\s\S]{0,80}不返回其他租户/);
});

test('每个平台读端点都记录请求字段和完整错误集', () => {
  const readEndpoints = [
    'GET /api/platform/overview',
    'GET /api/platform/applications',
    'GET /api/platform/tenants',
    'GET /api/platform/audit-logs',
  ];
  for (const endpoint of readEndpoints) {
    const heading = `### ${endpoint}`;
    const start = api.indexOf(heading);
    assert.notEqual(start, -1, `缺少 ${heading} 详细章节`);
    const nextHeading = api.indexOf('\n### ', start + heading.length);
    const section = api.slice(start, nextHeading === -1 ? api.length : nextHeading);
    for (const marker of ['角色', '请求字段', '无 body', 'query', '成功响应', '400', '401', '403', '404', '409']) {
      assert.ok(section.includes(marker), `${endpoint} 缺少 ${marker}`);
    }
  }
});

test('每个平台写端点都记录权限、请求、成功响应和完整错误集', () => {
  const writeHeadings = [
    'POST /api/enterprise-applications',
    'POST /api/platform/login',
    'POST /api/platform/applications/:id/approve',
    'POST /api/platform/applications/:id/reject',
    'POST /api/platform/tenants/:id/disable',
    'POST /api/platform/tenants/:id/restore',
    'POST /api/platform/tenants/:id/reset-supervisor-password',
    'PATCH /api/platform/tenants/:id',
  ];
  for (const [index, heading] of writeHeadings.entries()) {
    const start = api.indexOf(heading);
    assert.notEqual(start, -1, `缺少 ${heading}`);
    const nextStarts = writeHeadings
      .slice(index + 1)
      .map((item) => api.indexOf(item, start + heading.length))
      .filter((position) => position !== -1);
    const end = nextStarts.length ? Math.min(...nextStarts) : api.length;
    const section = api.slice(start, end);
    for (const marker of ['角色', '请求字段', '成功响应', '400', '401', '403', '404', '409']) {
      assert.ok(section.includes(marker), `${heading} 缺少 ${marker}`);
    }
  }
});

test('安全文档覆盖身份恢复、快照完整性和回滚', () => {
  for (const marker of [
    '威胁边界', 'session_version', '数据库恢复身份', '租户停用',
    '平台独立登录', 'bcrypt', '密码哈希', '审计', '快照完整性', '回滚',
  ]) {
    assert.ok(security.includes(marker), `安全文档缺少 ${marker}`);
  }
  assert.match(security, /审计[\s\S]{0,180}不(?:得|能|记录)[\s\S]{0,100}(?:密码|password)[\s\S]{0,100}(?:token|JWT)[\s\S]{0,100}(?:key|密钥)/i);
});

test('生产迁移顺序、确认口令和回滚条件有明确记录', () => {
  const ordered = [
    '停止写入', '下载并校验 Supabase 快照', 'npm run tenant:dry-run',
    '保存迁移前备份', 'npm run tenant:apply -- --confirm=MIGRATE-MULTI-TENANT',
    '验收', '上传新快照', '部署', '验证三个固定账号', '保留旧快照',
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = documentation.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `生产顺序缺少或乱序：${marker}`);
    cursor = next;
  }
  assert.match(documentation, /回滚条件/);
  assert.match(documentation, /回滚步骤/);
});

test('每份生产手册都以 Render 冻结副本为唯一权威候选并保持同一迁移路径', () => {
  const candidatePath = '/absolute/path/multi-tenant-candidate.db';
  const runbooks = {
    'README.md': readme,
    'docs/API.md': api,
    'docs/SECURITY-AUDIT.md': security,
  };
  for (const [file, content] of Object.entries(runbooks)) {
    assert.match(content, /Render\s+`?\/var\/data\/data\.db`?[\s\S]{0,100}唯一权威候选/, `${file} 必须指定 Render 权威源`);
    assert.ok(content.includes(candidatePath), `${file} 必须给出明确候选路径`);
    assert.match(content, /Supabase[\s\S]{0,80}(?:对照|备份)/, `${file} 必须限定 Supabase 用途`);
    assert.match(content, /(?:SHA-256|SHA)[\s\S]{0,120}表集合[\s\S]{0,120}记录数[\s\S]{0,160}不一致[\s\S]{0,120}中止/, `${file} 必须在对照不一致时中止`);
    assert.match(content, /不一致[\s\S]{0,180}(?:同步|排障)[\s\S]{0,180}不得迁移[\s\S]{0,80}远端快照/, `${file} 必须禁止迁移旧远端快照`);
    for (const command of [
      `npm run tenant:dry-run -- --source=${candidatePath}`,
      `npm run tenant:apply -- --confirm=MIGRATE-MULTI-TENANT --source=${candidatePath}`,
      `npm run verify:multi-tenant -- --source=${candidatePath}`,
    ]) {
      assert.ok(content.includes(command), `${file} 缺少同一候选路径命令：${command}`);
    }
  }
});

test('每份生产手册都要求不可变快照原子切换且验收前持续冻结', () => {
  for (const [file, content] of Object.entries({
    'README.md': readme,
    'docs/API.md': api,
    'docs/SECURITY-AUDIT.md': security,
  })) {
    assert.match(content, /新的?不可变\s*Supabase\s*对象/, `${file} 必须上传不可变对象`);
    assert.match(content, /校验[\s\S]{0,120}原子切换[\s\S]{0,80}`SUPABASE_DB_OBJECT`/, `${file} 必须校验后原子切换对象指针`);
    assert.match(content, /不(?:直接)?覆盖旧快照/, `${file} 必须保留旧快照`);
    assert.match(content, /保持停止写入[\s\S]{0,260}三个固定账号[\s\S]{0,160}跨租户隔离[\s\S]{0,120}完整性[\s\S]{0,120}持久化[\s\S]{0,120}恢复写入/, `${file} 必须给出完整冻结门槛`);
    assert.match(content, /验收失败[\s\S]{0,120}仍冻结[\s\S]{0,160}回滚[\s\S]{0,160}不丢失部署后写入/, `${file} 必须说明冻结回滚不丢写入`);
    assert.match(content, /提前恢复写入[\s\S]{0,160}增量重放[\s\S]{0,120}不作为本流程允许路径/, `${file} 必须排除无重放的提前写入`);
  }
});

test('Render 只声明受保护的敏感配置，不保存密密值', () => {
  for (const key of [
    'PLATFORM_PROVISIONING_SECRET', 'PLATFORM_OWNER_PASSWORD', 'BLANK_SUPERVISOR_PASSWORD',
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  ]) {
    const block = renderEnvBlock(key);
    assert.match(block, /sync:\s*false/);
    assert.doesNotMatch(block, /\bvalue\s*:/);
  }
  const jwt = renderEnvBlock('JWT_SECRET');
  assert.match(jwt, /(?:sync:\s*false|generateValue:\s*true)/);
  assert.doesNotMatch(jwt, /\bvalue\s*:/);
});

test('运维文档不包含敏感环境变量赋值或凭据模式', () => {
  const sensitiveAssignment = /\b[A-Z][A-Z0-9_]*(?:SECRET|KEY|PASSWORD|TOKEN)[A-Z0-9_]*\s*=\s*\S+/;
  assert.doesNotMatch(documentation, sensitiveAssignment);
  assert.doesNotMatch(documentation, /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/);
  assert.doesNotMatch(documentation, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/);
});

test('总体介绍不固定两类团队人数或比例', () => {
  const workerCount = String(3);
  const keeperCount = String(1);
  const fixedCounts = new RegExp(`${workerCount}\\s*名[\\s\\S]{0,40}(?:维修|师傅)[\\s\\S]{0,40}${keeperCount}\\s*名[\\s\\S]{0,40}(?:管家|物业)`);
  const fixedRatio = new RegExp(`${workerCount}\\s*(?:\\+|:|：|比)\\s*${keeperCount}[\\s\\S]{0,30}(?:师傅|管家|人员)`);
  assert.doesNotMatch(introduction, fixedCounts);
  assert.doesNotMatch(introduction, fixedRatio);
});
