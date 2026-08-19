# 多企业隔离与平台运维后台实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将现有共享数据的多主管实现改造成严格隔离的多企业系统，并交付唯一平台管理员、企业主管申请审核、四人团队限制和可审计的生产迁移。

**架构：** 继续使用单个 SQLite 数据库并通过 Supabase Storage 持久化，但每条企业业务记录必须带服务端注入的 `tenant_id`。认证中间件每次从数据库恢复账号角色、租户、状态和会话版本；企业 API 使用统一租户作用域，平台 API 使用独立 `platform_owner` 权限。生产迁移先把全部旧数据绑定测试租户，再创建平台管理员和空白“发财”租户，迁移校验通过后才允许服务启动。

**技术栈：** Node.js 24、Express 4、sql.js/SQLite、bcryptjs、jsonwebtoken、Node 内置测试运行器、原生 HTML/CSS/JavaScript、Supabase Storage 快照持久化。

---

## 文件结构

**新增文件**

- `services/tenant-schema.js`：创建租户、企业申请、平台审计表，并为业务表补充租户列和索引。
- `services/core-schema.js`：从 `db.js` 提取现有工单、小区、邀请码、注册、用户和状态表的幂等建表逻辑，供生产与测试共用。
- `services/tenant-context.js`：统一解析、断言和拼接服务端租户作用域。
- `services/tenant-migration.js`：旧数据归属分析、dry-run、事务迁移、完整性校验。
- `services/platform-provisioning.js`：幂等创建唯一平台管理员。
- `services/enterprise-applications.js`：企业申请、审核通过/拒绝、停用/恢复、平台统计。
- `routes/platform.js`：平台登录、申请审核、企业维护和审计 API。
- `scripts/provision-platform-owner.js`：受保护的平台管理员初始化命令。
- `scripts/migrate-multi-tenant.js`：生产迁移 dry-run/apply 命令。
- `public/platform-login.html`、`public/platform-admin.html`：独立平台页面。
- `public/js/platform-login.js`、`public/js/platform-admin.js`：平台登录和维护交互。
- `public/enterprise-apply.html`、`public/js/enterprise-apply.js`：公开企业主管开户申请页面。
- `test/helpers/tenant-fixture.js`：为所有隔离测试提供一致的完整结构、双租户账号和请求助手。
- `test/tenant-schema.test.js`、`test/tenant-migration.test.js`：结构与迁移测试。
- `test/tenant-auth.test.js`、`test/tenant-isolation.test.js`：鉴权和全接口跨租户测试。
- `test/enterprise-applications.test.js`、`test/platform-api.test.js`：平台工作流测试。
- `test/platform-ui.test.js`、`test/multi-tenant-production-migration.test.js`：页面和生产账号验收测试。

**重点修改文件**

- `db.js`、`workforce-schema.js`：在启动阶段创建结构并拒绝未完成的生产迁移。
- `middleware/auth.js`、`services/roles.js`：增加 `platform_owner`、租户身份和会话失效机制。
- `services/staff-lifecycle.js`、`services/team-capacity.js`：团队容量、审批和离职全部限定同租户。
- `services/ticket-access.js`、`services/ticket-activity.js`、`routes/tickets.js`：工单和附件严格按租户隔离。
- `routes/auth.js`、`routes/communities.js`、`routes/profiles.js`、`routes/staff.js`、`routes/directory.js`、`routes/shifts.js`、`routes/settings.js`、`routes/workforce-reports.js`、`routes/ai-reports.js`：所有查询和写入增加租户条件。
- `services/calendar.js`、`services/shifts.js`、`services/organization.js`、`services/reporting.js`、`services/performance.js`、`services/ai-report.js`：服务层接收 `tenantId` 并在最底层过滤。
- `server-app.js`、`index-new.js`、`config.js`：挂载平台路由、限流和安全启动校验，移除启动时创建普通主管的旧入口。
- `public/index.html`、`public/app.js`、`public/js/api.js`、`public/js/management-workspace.js`：隐藏平台能力并保持企业页面仅显示“工单系统”。
- `docs/API.md`、`docs/SECURITY-AUDIT.md`、`README.md`、`render.yaml`：记录新接口、密钥、迁移和回滚步骤。

### 任务 1：建立多租户数据库结构

**文件：**
- 创建：`services/tenant-schema.js`
- 创建：`services/core-schema.js`
- 修改：`db.js`
- 修改：`workforce-schema.js`
- 创建：`test/tenant-schema.test.js`
- 创建：`test/helpers/tenant-fixture.js`

- [ ] **步骤 1：编写失败的结构测试**

```js
test('多租户结构覆盖全部企业业务表', async () => {
  const db = await createFullTestDB();
  ensureTenantSchema(db);
  assert.deepEqual(columnNames(db, 'users').includes('tenant_id'), true);
  assert.deepEqual(columnNames(db, 'tickets').includes('tenant_id'), true);
  for (const table of TENANT_TABLES) {
    assert.equal(columnNames(db, table).includes('tenant_id'), true, table);
  }
  assert.ok(indexNames(db).includes('uq_users_phone'));
  assert.ok(indexNames(db).includes('uq_tenant_owner'));
});
```

- [ ] **步骤 2：运行结构测试并确认失败**

运行：`node --test --test-concurrency=1 test/tenant-schema.test.js`

预期：FAIL，提示 `Cannot find module '../services/tenant-schema'`。

- [ ] **步骤 3：实现租户结构**

```js
const TENANT_TABLES = [
  'users', 'staff_profiles', 'communities', 'community_permissions',
  'community_memberships', 'invite_codes', 'pending_registrations',
  'tickets', 'staff_status', 'shift_templates', 'shift_assignments',
  'attendance_records', 'attendance_change_logs', 'tenant_settings',
  'ticket_activity_logs', 'workforce_import_batches',
  'performance_rule_versions', 'ai_report_analyses', 'staff_lifecycle_audit',
];

function ensureTenantSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','disabled')),
    owner_user_id INTEGER UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT NOT NULL DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS enterprise_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enterprise_name TEXT NOT NULL,
    supervisor_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    rejection_reason TEXT NOT NULL DEFAULT '',
    reviewed_by_user_id INTEGER,
    reviewed_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_enterprise_phone
    ON enterprise_applications(phone) WHERE status = 'pending'`);
  db.run(`CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_tenant_id TEXT NOT NULL DEFAULT '',
    target_user_id INTEGER,
    summary_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tenant_settings (
    tenant_id TEXT PRIMARY KEY,
    reminder_interval_minutes INTEGER NOT NULL DEFAULT 30,
    sla_interval_minutes INTEGER NOT NULL DEFAULT 10,
    updated_by_user_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT ''
  )`);
  for (const table of TENANT_TABLES) {
    if (tableExists(db, table)) addColumn(db, table, "tenant_id TEXT DEFAULT ''");
  }
  addColumn(db, 'users', 'session_version INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'users', "last_login_at TEXT NOT NULL DEFAULT ''");
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone)');
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_single_platform_owner
    ON users(role) WHERE role = 'platform_owner'`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_supervisor
    ON users(tenant_id) WHERE role = '主管' AND COALESCE(tenant_id, '') <> ''`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_owner
    ON tenants(owner_user_id) WHERE owner_user_id IS NOT NULL`);
}
```

在 `db.js` 中于所有旧表创建完成、`ensureWorkforceSchema(db)` 执行后调用 `ensureTenantSchema(db)`。删除 `pending_registrations.community_id NOT NULL` 对新安装的全局假设，保留列但由租户邀请注册填充。移除启动时自动创建全局 `default` 小区的逻辑；小区只能由企业主管在自己的租户内创建，ID 使用 UUID。

`staff_status.name` 和 `performance_rule_versions.version_no` 目前是全局唯一，必须在本任务通过“新表复制—校验计数—替换旧表”重建为租户联合唯一约束：

```sql
CREATE TABLE staff_status_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT '',
  staff_profile_id INTEGER,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'on',
  updated TEXT,
  UNIQUE(tenant_id, staff_profile_id)
);
CREATE UNIQUE INDEX uq_performance_tenant_version
  ON performance_rule_versions(tenant_id, version_no);
```

`performance_rule_versions` 原表内嵌的 `version_no UNIQUE` 也要用同样方式重建并去掉全局唯一约束；复制前后行数必须一致，否则回滚。旧记录的空 `tenant_id` 留给任务 2 绑定测试租户。

同时创建统一测试夹具，后续任务只在这个文件中扩展，不重复拼装不一致的数据库：

```js
async function createFullTestDB() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  ensureCoreSchema(db);
  ensureWorkforceSchema(db);
  ensureTenantSchema(db);
  return db;
}

function one(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result[0]?.values[0]) return null;
  return Object.fromEntries(result[0].columns.map((column, index) => [column, result[0].values[0][index]]));
}

module.exports = { createFullTestDB, one };
```

`services/core-schema.js` 导出 `ensureCoreSchema(db)`，其函数体逐字迁移 `db.js` 当前对 `tickets`、`communities`、`community_permissions`、`invite_codes`、`pending_registrations`、`users` 和 `staff_status` 的 `CREATE TABLE IF NOT EXISTS` 及兼容列迁移；`db.js` 改为调用该函数，不保留第二份建表 SQL。

- [ ] **步骤 4：运行结构和旧迁移测试**

运行：`node --test --test-concurrency=1 test/tenant-schema.test.js test/workforce-schema.test.js test/database-migration.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add services/tenant-schema.js services/core-schema.js db.js workforce-schema.js test/tenant-schema.test.js test/helpers/tenant-fixture.js
git commit -m "feat: 建立多企业租户数据库结构"
```

### 任务 2：实现旧数据租户迁移和完整性闸门

**文件：**
- 创建：`services/tenant-migration.js`
- 创建：`scripts/migrate-multi-tenant.js`
- 创建：`test/tenant-migration.test.js`
- 修改：`db.js`
- 修改：`package.json`

- [ ] **步骤 1：编写迁移失败测试**

```js
async function legacyFixture() {
  const db = await createFullTestDB();
  db.run(`INSERT INTO users(id,phone,password,name,role,status,tenant_id) VALUES
    (1,'13800000001','x','主管','主管','active',''),
    (2,'13800000002','x','张师傅','worker','active','')`);
  db.run("INSERT INTO communities(id,name,created,tenant_id) VALUES('legacy-community','旧测试小区','2026-01-01','')");
  db.run("INSERT INTO tickets(id,type,created,community_id,tenant_id) VALUES('LEGACY-1','repair','2026-01-01','legacy-community','')");
  return db;
}

test('旧测试数据全部归入 13800000001 的测试租户', async () => {
  const db = await legacyFixture();
  const preview = inspectTenantMigration(db);
  assert.equal(preview.conflicts.length, 0);
  const result = applyTenantMigration(db, {
    testSupervisorPhone: '13800000001',
    testTenantId: 'tenant-test',
    testTenantName: '全流程测试企业',
  });
  assert.equal(result.applied, true);
  assert.equal(one(db, "SELECT tenant_id FROM users WHERE phone='13800000002'").tenant_id, 'tenant-test');
  assert.equal(assertTenantIntegrity(db).ok, true);
});

test('存在无法归属的历史记录时迁移回滚', async () => {
  const db = await legacyFixture();
  const migrationInput = {
    testSupervisorPhone: '13800000001', testTenantId: 'tenant-test',
    testTenantName: '全流程测试企业', nowIso: '2026-08-19T00:00:00.000Z',
  };
  db.run("INSERT INTO users(phone,password,name,role) VALUES('13900000000','x','孤立主管','主管')");
  assert.throws(() => applyTenantMigration(db, migrationInput), /TENANT_MIGRATION_CONFLICT/);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM tenants').count, 0);
});
```

- [ ] **步骤 2：运行迁移测试并确认失败**

运行：`node --test --test-concurrency=1 test/tenant-migration.test.js`

预期：FAIL，提示缺少 `services/tenant-migration.js`。

- [ ] **步骤 3：实现分析、事务迁移和校验**

```js
function assertTenantIntegrity(db) {
  const empty = TENANT_TABLES.flatMap((table) => {
    if (!tableExists(db, table)) return [];
    const count = one(db, `SELECT COUNT(*) AS count FROM ${table}
      WHERE COALESCE(tenant_id, '') = ''`).count;
    return Number(count) ? [{ table, count: Number(count) }] : [];
  });
  const supervisors = all(db, `SELECT tenant_id, COUNT(*) AS count FROM users
    WHERE role = '主管' AND status = 'active' GROUP BY tenant_id HAVING COUNT(*) <> 1`);
  return { ok: empty.length === 0 && supervisors.length === 0, empty, supervisors };
}

function applyTenantMigration(db, input) {
  const preview = inspectTenantMigration(db, input);
  if (preview.conflicts.length) throw migrationError(preview.conflicts);
  return transaction(db, () => {
    db.run(`INSERT INTO tenants(id,name,status,created_at,updated_at)
      VALUES(?,?,'active',?,?)`, [input.testTenantId, input.testTenantName, input.nowIso, input.nowIso]);
    for (const table of TENANT_TABLES) {
      if (tableExists(db, table)) db.run(`UPDATE ${table} SET tenant_id = ? WHERE COALESCE(tenant_id,'') = ''`, [input.testTenantId]);
    }
    const owner = one(db, 'SELECT id FROM users WHERE phone = ?', [input.testSupervisorPhone]);
    db.run('UPDATE tenants SET owner_user_id = ? WHERE id = ?', [owner.id, input.testTenantId]);
    const integrity = assertTenantIntegrity(db);
    if (!integrity.ok) throw migrationError(integrity);
    return { applied: true, integrity };
  });
}
```

命令必须支持：

```bash
npm run tenant:dry-run
npm run tenant:apply -- --confirm=MIGRATE-MULTI-TENANT
```

未传 `--confirm` 时不得写数据库。`db.js` 在 `NODE_ENV=production` 且检测到已有业务数据但空 `tenant_id` 时抛出 `TENANT_MIGRATION_REQUIRED`，禁止带风险启动。

- [ ] **步骤 4：运行迁移测试**

运行：`node --test --test-concurrency=1 test/tenant-migration.test.js test/database-migration.test.js`

预期：全部 PASS，冲突夹具保持事务前状态。

- [ ] **步骤 5：提交**

```bash
git add services/tenant-migration.js scripts/migrate-multi-tenant.js test/tenant-migration.test.js db.js package.json
git commit -m "feat: 增加多租户安全迁移和启动闸门"
```

### 任务 3：让认证身份只信任数据库

**文件：**
- 修改：`middleware/auth.js`
- 修改：`services/roles.js`
- 修改：`routes/auth.js`
- 创建：`test/tenant-auth.test.js`
- 修改：`test/helpers/auth.js`
- 修改：`test/helpers/tenant-fixture.js`

- [ ] **步骤 1：编写伪造租户和停用会话测试**

```js
test('JWT 中伪造的角色和 tenant_id 被数据库身份覆盖', async (t) => {
  const server = await tenantServer(t);
  const result = await get(server, '/api/me', authHeader({
    id: 2, role: '主管', tenant_id: 'tenant-b', session_version: 999,
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.user.role, 'worker');
  assert.equal(result.body.user.tenant_id, 'tenant-a');
});

test('企业停用或 session_version 变化后旧 token 立即失效', async (t) => {
  const server = await tenantServer(t);
  const old = authHeader({ id: 1, session_version: 1 });
  db.run("UPDATE tenants SET status='disabled' WHERE id='tenant-a'");
  assert.equal((await get(server, '/api/me', old)).status, 401);
});
```

- [ ] **步骤 2：运行认证测试并确认失败**

运行：`node --test --test-concurrency=1 test/tenant-auth.test.js`

预期：FAIL，当前 `req.user` 不包含数据库租户且不检查租户状态。

- [ ] **步骤 3：实现数据库身份恢复和权限中间件**

```js
function generateToken(user, rememberMe) {
  return jwt.sign(
    { id: user.id, session_version: Number(user.session_version || 1) },
    config.JWT_SECRET,
    { expiresIn: rememberMe ? config.JWT_EXPIRES_LONG : config.JWT_EXPIRES }
  );
}

function loadCurrentIdentity(userId) {
  return queryOne(`SELECT u.id,u.phone,u.name,u.role,u.status,u.tenant_id,u.session_version,
      t.status AS tenant_status
    FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id WHERE u.id=?`, [userId]);
}

function requirePlatformOwner(req, res, next) {
  if (!req.user || req.user.role !== 'platform_owner') {
    return res.status(403).json({ error: '需要平台运维权限', code: 'PLATFORM_OWNER_REQUIRED' });
  }
  next();
}

function requireTenantUser(req, res, next) {
  if (!req.user?.tenant_id || req.user.role === 'platform_owner') {
    return res.status(403).json({ error: '需要企业账号', code: 'TENANT_USER_REQUIRED' });
  }
  next();
}
```

`verifyToken` 必须检查用户 `active`、`session_version` 相等，并对企业账号检查租户 `active`。`requireAdmin` 只允许 `role === '主管' && tenant_id`，不再接受 `admin/manager/supervisor` 别名。登录响应返回数据库中的 `tenant_id`，平台账号登录企业入口返回 403。

在 `server-app.js` 中为 `/api/tickets`、`/api/communities` 以及档案、目录、排班、报告、AI 和设置路由统一前置 `requireTenantUser`。公开登录、邀请码注册、企业申请、健康检查和 `/api/platform/*` 不挂企业中间件。测试夹具增加：

```js
async function tenantServer(t) {
  const db = await createFullTestDB();
  seedTenant(db, { tenantId: 'tenant-a', managerId: 1, managerPhone: '13800000001' });
  const server = await startHttpServer(db);
  t.after(server.close);
  return { db, server };
}
```

成功登录后执行 `UPDATE users SET last_login_at=? WHERE id=?` 并持久化，供平台企业维护列表展示。

- [ ] **步骤 4：运行认证回归测试**

运行：`node --test --test-concurrency=1 test/tenant-auth.test.js test/auth-security.test.js test/auth-token-sync.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add middleware/auth.js services/roles.js routes/auth.js server-app.js test/tenant-auth.test.js test/helpers/auth.js test/helpers/tenant-fixture.js
git commit -m "feat: 强制从数据库恢复租户认证身份"
```

### 任务 4：建立统一租户作用域并隔离基础资料

**文件：**
- 创建：`services/tenant-context.js`
- 修改：`routes/communities.js`
- 修改：`routes/profiles.js`
- 修改：`routes/staff.js`
- 修改：`routes/directory.js`
- 修改：`services/organization.js`
- 创建：`test/tenant-isolation.test.js`
- 修改：`test/helpers/tenant-fixture.js`

- [ ] **步骤 1：编写两个企业的基础资料隔离测试**

```js
for (const endpoint of ['/api/communities', '/api/staff/profiles', '/api/organization/tree', '/api/staff/directory']) {
  test(`${endpoint} 不返回其他企业数据`, async (t) => {
    const { server } = await twoTenantFixture(t);
    const result = await api(server, endpoint, TENANT_A_MANAGER);
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result.body).includes('tenant-b-secret'), false);
  });
}

test('主管不能通过路径 ID 修改其他企业档案', async (t) => {
  const { server } = await twoTenantFixture(t);
  const result = await api(server, '/api/staff/profiles/202', TENANT_A_MANAGER, {
    method: 'PATCH', body: JSON.stringify({ name: '越权修改' }),
  });
  assert.equal(result.status, 403);
});
```

- [ ] **步骤 2：运行隔离测试并确认失败**

运行：`node --test --test-concurrency=1 test/tenant-isolation.test.js`

预期：FAIL，主管当前能读取全局小区和档案。

- [ ] **步骤 3：实现作用域助手并改造基础资料路由**

```js
function tenantIdFrom(req) {
  const tenantId = String(req.user?.tenant_id || '');
  if (!tenantId) throw httpError(403, 'TENANT_CONTEXT_REQUIRED');
  return tenantId;
}

function findTenantRow(db, table, idColumn, id, tenantId) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(idColumn);
  return one(db, `SELECT * FROM ${table} WHERE ${idColumn}=? AND tenant_id=?`, [id, tenantId]);
}
```

所有列表 SQL 加 `WHERE tenant_id = ?`；详情读取使用“主键 + tenant_id”查找，跨租户返回 404；修改和删除先解析真实目标租户，目标存在但不属于当前租户时返回 403 `CROSS_TENANT_WRITE_FORBIDDEN`。所有 INSERT 的 `tenant_id` 只能取 `tenantIdFrom(req)`，请求体中的 `tenant_id` 和 `tenantId` 返回 400 `CLIENT_TENANT_FORBIDDEN`。服务层 `organization` 的公开函数签名改为 `(db, tenantId, ...)`。

测试夹具在本任务扩展为固定双租户数据，供后续所有路由复用：

```js
const TENANT_A_MANAGER = { id: 1, session_version: 1 };
const TENANT_B_MANAGER = { id: 101, session_version: 1 };

async function twoTenantFixture(t) {
  const db = await createFullTestDB();
  seedTenant(db, { tenantId: 'tenant-a', managerId: 1, managerPhone: '13800000001', marker: 'tenant-a-secret' });
  seedTenant(db, { tenantId: 'tenant-b', managerId: 101, managerPhone: '13900000001', marker: 'tenant-b-secret' });
  const server = await startHttpServer(db);
  t.after(server.close);
  return { db, server };
}

async function api(server, pathname, user, options = {}) {
  const response = await fetch(`${server.url}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeader(user), ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
}
```

- [ ] **步骤 4：运行基础资料和组织回归测试**

运行：`node --test --test-concurrency=1 test/tenant-isolation.test.js test/profiles-api.test.js test/directory.test.js test/organization.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add services/tenant-context.js routes/communities.js routes/profiles.js routes/staff.js routes/directory.js services/organization.js test/tenant-isolation.test.js test/helpers/tenant-fixture.js
git commit -m "feat: 隔离企业小区人员和通讯录"
```

### 任务 5：隔离工单、流转和附件

**文件：**
- 修改：`services/ticket-access.js`
- 修改：`services/ticket-activity.js`
- 修改：`routes/tickets.js`
- 修改：`server-app.js`
- 修改：`test/ticket-scope.test.js`
- 修改：`test/ticket-activity.test.js`
- 修改：`test/tenant-isolation.test.js`
- 修改：`test/helpers/tenant-fixture.js`

- [ ] **步骤 1：增加工单越权测试**

```js
test('主管只能读取和写入本企业工单', async (t) => {
  const { server } = await twoTenantFixture(t);
  assert.equal((await api(server, '/api/tickets/B-1', TENANT_A_MANAGER)).status, 404);
  assert.equal((await api(server, '/api/tickets/B-1', TENANT_A_MANAGER, {
    method: 'PATCH', body: JSON.stringify({ status: 'done' }),
  })).status, 403);
  const list = await api(server, '/api/tickets', TENANT_A_MANAGER);
  assert.deepEqual(list.body.data.map(item => item.id), ['A-1']);
});

test('工单创建忽略客户端租户并绑定登录企业', async (t) => {
  const { server } = await twoTenantFixture(t);
  const created = await api(server, '/api/tickets', TENANT_A_MANAGER, {
    method: 'POST', body: JSON.stringify({ type: 'repair', community_id: 'a-community', tenant_id: 'tenant-b' }),
  });
  assert.equal(created.status, 400);
  assert.equal(created.body.code, 'CLIENT_TENANT_FORBIDDEN');
});
```

- [ ] **步骤 2：运行工单测试并确认失败**

运行：`node --test --test-concurrency=1 test/ticket-scope.test.js test/tenant-isolation.test.js`

预期：FAIL，主管仍有全局工单访问权。

- [ ] **步骤 3：改造工单访问和写入**

```js
function ticketScope(user) {
  if (!user?.tenant_id) return { sql: '1=0', params: [] };
  if (isSupervisorUser(user)) return { sql: 'tenant_id = ?', params: [user.tenant_id] };
  return {
    sql: "tenant_id = ? AND assignee_user_id = ? AND type IN ('repair','complaint','help')",
    params: [user.tenant_id, user.id],
  };
}
```

列表、详情、修改、删除、照片列表和上传都必须先匹配 `ticket.id + tenant_id`。工单 INSERT、`ticket_activity_logs` INSERT 必须写 `req.user.tenant_id`。派单目标必须通过 `user_id + tenant_id + active` 校验；小区必须通过 `community_id + tenant_id` 校验。

- [ ] **步骤 4：运行工单、社区和附件回归测试**

运行：`node --test --test-concurrency=1 test/ticket-scope.test.js test/ticket-activity.test.js test/ticket-community.test.js test/tenant-isolation.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add services/ticket-access.js services/ticket-activity.js routes/tickets.js server-app.js test/ticket-scope.test.js test/ticket-activity.test.js test/tenant-isolation.test.js
git commit -m "feat: 隔离企业工单流转和附件"
```

### 任务 6：隔离排班、报告、绩效、设置和 AI 缓存

**文件：**
- 修改：`routes/shifts.js`
- 修改：`routes/workforce-reports.js`
- 修改：`routes/settings.js`
- 修改：`routes/ai-reports.js`
- 删除：`routes/attendance.js`
- 删除：`test/attendance-delete.test.js`
- 修改：`server-app.js`
- 修改：`services/shifts.js`
- 修改：`services/calendar.js`
- 修改：`services/reporting.js`
- 修改：`services/performance.js`
- 修改：`services/ai-report.js`
- 修改：`test/tenant-isolation.test.js`

- [ ] **步骤 1：增加派生数据跨租户测试**

```js
const derivedEndpoints = [
  '/api/shift-templates', '/api/shifts?from=2026-08-01&to=2026-08-31',
  '/api/calendar/day?date=2026-08-19', '/api/dashboard/stats',
  '/api/reports/staff/all?from=2026-08-01&to=2026-08-31',
  '/api/settings/performance',
];
for (const endpoint of derivedEndpoints) {
  test(`${endpoint} 只聚合当前企业`, async (t) => {
    const result = await api((await twoTenantFixture(t)).server, endpoint, TENANT_A_MANAGER);
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result.body).includes('tenant-b-secret'), false);
  });
}
```

- [ ] **步骤 2：运行派生数据测试并确认失败**

运行：`node --test --test-concurrency=1 test/tenant-isolation.test.js test/reporting.test.js test/performance.test.js`

预期：FAIL，报告和规则仍使用全局数据。

- [ ] **步骤 3：把 tenantId 传到服务层最底部**

```js
function generateStaffReport(db, { tenantId, staffId, from, to, communityId }) {
  const staff = one(db, 'SELECT * FROM staff_profiles WHERE id=? AND tenant_id=?', [staffId, tenantId]);
  if (!staff) throw reportError(404, 'STAFF_NOT_FOUND');
  const params = [tenantId, staffId, from, to];
  const tickets = all(db, `SELECT * FROM tickets
    WHERE tenant_id=? AND assignee_staff_profile_id=? AND created>=? AND created<?`, params);
  return buildReport(staff, tickets);
}
```

`shift_templates`、`performance_rule_versions` 和 `ai_report_analyses` 从全局配置改为每租户配置。AI 缓存唯一索引改为 `(tenant_id, report_hash, model, prompt_version)`。团队汇总和个人报告必须将 `tenantId` 纳入报告哈希，禁止租户 A 命中租户 B 缓存。

提醒和 SLA 周期从模块级全局变量迁入 `tenant_settings`。按照已确认的“删除考勤”产品规则，`server-app.js` 不再挂载 `routes/attendance.js`，删除 `/api/attendance/*` 和 `/api/me/attendance`；排班、请假和日历继续保留，但报告与“我的”响应不再返回任何考勤字段。遗留考勤表仅为旧快照兼容保留并带 `tenant_id`，不提供 HTTP 访问。

- [ ] **步骤 4：运行派生数据回归测试**

运行：`node --test --test-concurrency=1 test/shifts.test.js test/calendar.test.js test/reporting.test.js test/performance.test.js test/ai-report.test.js test/ai-report-route.test.js test/tenant-isolation.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add routes/shifts.js routes/workforce-reports.js routes/settings.js routes/ai-reports.js server-app.js services/shifts.js services/calendar.js services/reporting.js services/performance.js services/ai-report.js test/tenant-isolation.test.js
git rm routes/attendance.js test/attendance-delete.test.js
git commit -m "feat: 隔离企业排班绩效报告和 AI 数据"
```

### 任务 7：限定企业人员注册、四人容量和离职

**文件：**
- 修改：`routes/auth.js`
- 修改：`services/staff-lifecycle.js`
- 修改：`services/team-capacity.js`
- 修改：`services/account-lifecycle.js`
- 修改：`test/staff-lifecycle.test.js`
- 修改：`test/team-capacity.test.js`
- 修改：`test/tenant-isolation.test.js`

- [ ] **步骤 1：编写同租户审批、离职和容量测试**

```js
async function lifecycleTenantFixture() {
  const db = await createFullTestDB();
  const seeded = seedTenant(db, {
    tenantId: 'tenant-a', managerId: 1, managerPhone: '13800000001',
    workers: 3, keepers: 1, includeHistoricalTicket: true,
  });
  return { db, workerA: seeded.workers[0], managerA: seeded.manager };
}

test('邀请码注册申请继承邀请码租户且只能由本企业主管审批', async (t) => {
  const { server } = await twoTenantFixture(t);
  const denied = await api(server, '/api/pending-registrations/900/approve', TENANT_B_MANAGER, { method: 'POST' });
  assert.equal(denied.status, 404);
  const approved = await api(server, '/api/pending-registrations/900/approve', TENANT_A_MANAGER, { method: 'POST' });
  assert.equal(approved.status, 200);
});

test('离职释放名额但历史工单保留已离职身份', async () => {
  const { db, workerA, managerA } = await lifecycleTenantFixture();
  const result = departStaff(db, workerA.id, TENANT_A_MANAGER);
  assert.equal(one(db, 'SELECT id FROM users WHERE id=?', [workerA.id]), null);
  assert.equal(one(db, 'SELECT employment_status FROM staff_profiles WHERE id=?', [workerA.profileId]).employment_status, 'departed');
  assert.equal(one(db, "SELECT tenant_id FROM tickets WHERE id='A-OLD'").tenant_id, 'tenant-a');
  assert.equal(teamUsage(db, managerA.profileId, { tenantId: 'tenant-a' }).worker, 2);
});
```

- [ ] **步骤 2：运行人员生命周期测试并确认失败**

运行：`node --test --test-concurrency=1 test/staff-lifecycle.test.js test/team-capacity.test.js test/tenant-isolation.test.js`

预期：FAIL，审批和用户列表没有租户条件。

- [ ] **步骤 3：实现租户内生命周期**

```js
function assertSameTenant(actorUser, targetTenantId) {
  if (!isSupervisorUser(actorUser) || actorUser.tenant_id !== targetTenantId) {
    throw lifecycleError('记录不存在', 'TENANT_TARGET_NOT_FOUND', 404);
  }
}

function teamUsage(db, managerProfileId, { tenantId, excludeProfileId } = {}) {
  return all(db, `SELECT position FROM staff_profiles
    WHERE tenant_id=? AND manager_id=? AND employment_status='active'
      AND (? IS NULL OR id<>?)`, [tenantId, managerProfileId, excludeProfileId ?? null, excludeProfileId ?? null]);
}
```

创建账号、审批申请、人员档案、社区成员关系和生命周期审计均写入 actor 的 `tenant_id`。离职目标必须匹配同租户且角色只能是 `worker/keeper`；先保留 `staff_profile` 历史身份，再删除登录账号并递增关联会话版本。用户列表只返回当前租户普通人员，不返回任何主管或平台管理员。

- [ ] **步骤 4：运行人员与安全回归测试**

运行：`node --test --test-concurrency=1 test/staff-lifecycle.test.js test/team-capacity.test.js test/auth-security.test.js test/tenant-isolation.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add routes/auth.js services/staff-lifecycle.js services/team-capacity.js services/account-lifecycle.js test/staff-lifecycle.test.js test/team-capacity.test.js test/tenant-isolation.test.js test/helpers/tenant-fixture.js
git commit -m "feat: 限定企业四人团队和离职生命周期"
```

### 任务 8：实现企业主管公开申请和平台审核服务

**文件：**
- 创建：`services/enterprise-applications.js`
- 创建：`test/enterprise-applications.test.js`

- [ ] **步骤 1：编写申请、通过、拒绝和幂等测试**

```js
const PLATFORM_OWNER = { id: 900, role: 'platform_owner', tenant_id: '' };
let db;
test.beforeEach(async () => { db = await createFullTestDB(); });

test('申请通过在一个事务内创建空租户和唯一主管', async () => {
  const application = await submitEnterpriseApplication(db, {
    enterpriseName: '甲物业', supervisorName: '甲主管', phone: '13900000001', password: 'SecurePass!123',
  });
  const approved = approveEnterpriseApplication(db, application.id, PLATFORM_OWNER);
  assert.equal(one(db, 'SELECT owner_user_id FROM tenants WHERE id=?', [approved.tenantId]).owner_user_id, approved.userId);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM users WHERE tenant_id=?', [approved.tenantId]).count, 1);
  assert.equal(one(db, 'SELECT password_hash FROM enterprise_applications WHERE id=?', [application.id]).password_hash, '');
});

test('重复审核和手机号占用返回冲突且不创建第二租户', async () => {
  const application = await submitEnterpriseApplication(db, {
    enterpriseName: '乙物业', supervisorName: '乙主管', phone: '13900000002', password: 'SecurePass!456',
  });
  approveEnterpriseApplication(db, application.id, PLATFORM_OWNER);
  assert.throws(() => approveEnterpriseApplication(db, application.id, PLATFORM_OWNER), /APPLICATION_ALREADY_REVIEWED/);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM tenants').count, 1);
});
```

- [ ] **步骤 2：运行申请测试并确认失败**

运行：`node --test --test-concurrency=1 test/enterprise-applications.test.js`

预期：FAIL，服务文件不存在。

- [ ] **步骤 3：实现申请和审核事务**

```js
async function submitEnterpriseApplication(db, input) {
  validateEnterpriseApplication(input);
  if (one(db, 'SELECT id FROM users WHERE phone=?', [input.phone])) throw conflict('PHONE_IN_USE');
  if (one(db, "SELECT id FROM enterprise_applications WHERE phone=? AND status='pending'", [input.phone])) throw conflict('APPLICATION_PENDING');
  const hash = await bcrypt.hash(input.password, 12);
  db.run(`INSERT INTO enterprise_applications
    (enterprise_name,supervisor_name,phone,password_hash,status,created_at)
    VALUES(?,?,?,?, 'pending',?)`, [input.enterpriseName, input.supervisorName, input.phone, hash, nowIso()]);
  return one(db, 'SELECT id,status FROM enterprise_applications WHERE id=last_insert_rowid()');
}

function approveEnterpriseApplication(db, id, actor) {
  assertPlatformOwner(actor);
  return transaction(db, () => {
    const app = one(db, "SELECT * FROM enterprise_applications WHERE id=? AND status='pending'", [id]);
    if (!app) throw conflict('APPLICATION_ALREADY_REVIEWED');
    const tenantId = crypto.randomUUID();
    db.run(`INSERT INTO tenants(id,name,status,created_at,updated_at)
      VALUES(?,?,'active',?,?)`, [tenantId, app.enterprise_name, nowIso(), nowIso()]);
    db.run(`INSERT INTO users(phone,password,name,role,status,tenant_id,session_version)
      VALUES(?,?,?,'主管','active',?,1)`, [app.phone, app.password_hash, app.supervisor_name, tenantId]);
    const userId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
    db.run('UPDATE tenants SET owner_user_id=? WHERE id=?', [userId, tenantId]);
    createSupervisorProfile(db, { tenantId, userId, name: app.supervisor_name, phone: app.phone });
    db.run(`UPDATE enterprise_applications SET status='approved',password_hash='',reviewed_by_user_id=?,reviewed_at=? WHERE id=?`, [actor.id, nowIso(), id]);
    writePlatformAudit(db, actor, 'enterprise.approve', tenantId, userId, { applicationId: Number(id) });
    return { tenantId, userId };
  });
}
```

拒绝操作必须写拒绝原因、清空密码哈希并记录平台审计。

- [ ] **步骤 4：运行申请测试**

运行：`node --test --test-concurrency=1 test/enterprise-applications.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add services/enterprise-applications.js test/enterprise-applications.test.js
git commit -m "feat: 增加企业主管申请审核事务"
```

### 任务 9：实现平台管理员初始化和平台 API

**文件：**
- 创建：`services/platform-provisioning.js`
- 创建：`scripts/provision-platform-owner.js`
- 创建：`routes/platform.js`
- 创建：`routes/enterprise-applications.js`
- 修改：`server-app.js`
- 修改：`config.js`
- 创建：`test/platform-api.test.js`
- 修改：`test/config-env.test.js`
- 修改：`test/helpers/tenant-fixture.js`

- [ ] **步骤 1：编写初始化和平台权限测试**

```js
test('平台管理员初始化幂等且拒绝给已有企业账号提权', async () => {
  const input = {
    secret: 'provision-secret-32-characters-long', expectedSecret: 'provision-secret-32-characters-long',
    phone: '13222514178', name: '句子工单管理员', password: 'OwnerSecure!123',
  };
  const first = await provisionPlatformOwner(db, input);
  const second = await provisionPlatformOwner(db, input);
  assert.equal(first.userId, second.userId);
  assert.equal(one(db, 'SELECT tenant_id FROM users WHERE id=?', [first.userId]).tenant_id, '');
});

test('主管访问平台接口返回 403，平台账号可审核和停用企业', async (t) => {
  const { server } = await platformFixture(t);
  const PLATFORM_OWNER_TOKEN = { id: 900, session_version: 1 };
  assert.equal((await api(server, '/api/platform/overview', TENANT_A_MANAGER)).status, 403);
  assert.equal((await api(server, '/api/platform/overview', PLATFORM_OWNER_TOKEN)).status, 200);
  assert.equal((await api(server, '/api/platform/tenants/tenant-a/disable', PLATFORM_OWNER_TOKEN, { method: 'POST' })).status, 200);
});
```

- [ ] **步骤 2：运行平台 API 测试并确认失败**

运行：`node --test --test-concurrency=1 test/platform-api.test.js test/config-env.test.js`

预期：FAIL，平台服务和路由不存在。

- [ ] **步骤 3：实现受保护初始化和平台路由**

```js
router.post('/login', platformLoginLimiter, loginPlatformOwner);
router.get('/overview', requireAuth, requirePlatformOwner, getOverview);
router.get('/applications', requireAuth, requirePlatformOwner, listApplications);
router.post('/applications/:id/approve', requireAuth, requirePlatformOwner, approveApplication);
router.post('/applications/:id/reject', requireAuth, requirePlatformOwner, rejectApplication);
router.get('/tenants', requireAuth, requirePlatformOwner, listTenants);
router.patch('/tenants/:id', requireAuth, requirePlatformOwner, renameTenant);
router.post('/tenants/:id/disable', requireAuth, requirePlatformOwner, disableTenant);
router.post('/tenants/:id/restore', requireAuth, requirePlatformOwner, restoreTenant);
router.post('/tenants/:id/reset-supervisor-password', requireAuth, requirePlatformOwner, resetSupervisorPassword);
router.get('/audit-logs', requireAuth, requirePlatformOwner, listAuditLogs);
```

公开申请使用独立路由，避免与需要平台权限的路由混挂：

```js
enterpriseRouter.post('/enterprise-applications', enterpriseApplicationLimiter, async (req, res) => {
  const application = await submitEnterpriseApplication(getDB(), req.body);
  await saveDB();
  res.status(201).json({ success: true, application: { id: application.id, status: application.status } });
});
```

`platformFixture(t)` 在统一夹具中创建 `platform_owner`、两个租户及各自主管，并启动 HTTP 服务；测试不得通过 JWT claims 伪造平台角色。

```js
async function platformFixture(t) {
  const fixture = await twoTenantFixture(t);
  fixture.db.run(`INSERT INTO users
    (id,phone,password,name,role,status,tenant_id,session_version)
    VALUES(900,'13222514178','fixture-hash','句子工单管理员','platform_owner','active','',1)`);
  return fixture;
}
```

平台企业列表返回 `name`、主管姓名/手机号、状态、创建时间、主管 `last_login_at`、普通人员用量、小区数和工单数。重命名只接受 2—80 个字符的非空企业名称并写平台审计。

初始化命令只从 `PLATFORM_PROVISIONING_SECRET`、`PLATFORM_OWNER_PASSWORD` 读取密钥和密码，要求参数 `--confirm`；日志仅输出用户 ID、手机号后四位和 created/unchanged，不输出任何密钥或哈希。停用/恢复/重置密码均递增相关用户 `session_version`。

- [ ] **步骤 4：运行平台 API 和安全测试**

运行：`node --test --test-concurrency=1 test/platform-api.test.js test/tenant-auth.test.js test/config-env.test.js test/auth-security.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add services/platform-provisioning.js scripts/provision-platform-owner.js routes/platform.js routes/enterprise-applications.js server-app.js config.js test/platform-api.test.js test/config-env.test.js test/helpers/tenant-fixture.js
git commit -m "feat: 增加平台管理员初始化和维护接口"
```

### 任务 10：实现独立平台登录和运维后台页面

**文件：**
- 创建：`public/platform-login.html`
- 创建：`public/platform-admin.html`
- 创建：`public/js/platform-login.js`
- 创建：`public/js/platform-admin.js`
- 创建：`public/enterprise-apply.html`
- 创建：`public/js/enterprise-apply.js`
- 修改：`public/styles.css`
- 修改：`public/index.html`
- 修改：`public/app.js`
- 创建：`test/platform-ui.test.js`

- [ ] **步骤 1：编写静态页面和访问控制测试**

```js
test('平台页面使用独立入口且企业首页不暴露平台菜单', () => {
  const login = fs.readFileSync('public/platform-login.html', 'utf8');
  const admin = fs.readFileSync('public/platform-admin.html', 'utf8');
  const apply = fs.readFileSync('public/enterprise-apply.html', 'utf8');
  const enterprise = fs.readFileSync('public/index.html', 'utf8');
  assert.match(login, /平台运维登录/);
  assert.match(admin, /企业注册审核/);
  assert.match(apply, /企业主管开户申请/);
  assert.doesNotMatch(enterprise, /平台运维后台/);
});

test('平台脚本收到 401 或 403 时清除平台 token 并返回登录页', () => {
  const script = fs.readFileSync('public/js/platform-admin.js', 'utf8');
  assert.match(script, /platform_token/);
  assert.match(script, /location\.replace\('\/platform-login\.html'\)/);
});
```

- [ ] **步骤 2：运行页面测试并确认失败**

运行：`node --test --test-concurrency=1 test/platform-ui.test.js`

预期：FAIL，平台页面不存在。

- [ ] **步骤 3：实现页面和交互**

平台后台必须包含以下稳定 DOM 区域：

```html
<main class="platform-shell">
  <section id="overviewCards" aria-label="平台总览"></section>
  <section id="applicationPanel" aria-label="企业注册审核"></section>
  <section id="tenantPanel" aria-label="企业维护"></section>
  <section id="auditPanel" aria-label="平台审计日志"></section>
</main>
```

前端请求只使用 `sessionStorage.platform_token`，不得复用企业端 localStorage token。审核拒绝必须要求非空原因；停用企业和重置密码必须二次确认；任何列表都不得渲染密码、哈希、JWT 或 Supabase/AI 密钥。

公开申请页只提交 `enterpriseName`、`supervisorName`、`phone` 和 `password` 到 `/api/enterprise-applications`；成功后只显示申请编号和“等待平台审核”，不自动登录，也不把密码写入 localStorage/sessionStorage。

- [ ] **步骤 4：运行页面、统一标题和服务测试**

运行：`node --test --test-concurrency=1 test/platform-ui.test.js test/server-app.test.js test/unified-visual-style.test.js test/frontend-feature.test.js`

预期：全部 PASS，企业端标题仍为“工单系统”。

- [ ] **步骤 5：提交**

```bash
git add public/platform-login.html public/platform-admin.html public/js/platform-login.js public/js/platform-admin.js public/enterprise-apply.html public/js/enterprise-apply.js public/styles.css public/index.html public/app.js test/platform-ui.test.js
git commit -m "feat: 增加独立平台运维后台页面"
```

### 任务 11：迁移保留测试企业并创建空白“发财”企业

**文件：**
- 修改：`services/tenant-migration.js`
- 修改：`scripts/migrate-multi-tenant.js`
- 删除：`services/startup-standalone-manager.js`
- 删除：`services/standalone-manager.js`
- 修改：`index-new.js`
- 创建：`test/multi-tenant-production-migration.test.js`
- 修改：`test/helpers/tenant-fixture.js`
- 删除：`test/startup-standalone-manager.test.js`
- 删除：`test/standalone-manager.test.js`

- [ ] **步骤 1：编写三类固定账号迁移验收测试**

```js
test('生产迁移保留测试数据并创建平台账号和空白发财企业', async () => {
  const db = await retainedFixture();
  const summary = await applyProductionTenantMigration(db, {
    testSupervisorPhone: '13800000001',
    platformOwnerPhone: '13222514178', platformOwnerName: '句子工单管理员',
    platformOwnerPassword: 'OwnerSecure!123',
    blankSupervisorPhone: '17713302589', blankSupervisorName: '发财',
    blankSupervisorPassword: 'BlankSecure!123', blankTenantName: '发财企业',
  });
  const blank = one(db, "SELECT tenant_id FROM users WHERE phone='17713302589'");
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM tickets WHERE tenant_id=?', [blank.tenant_id]).count, 0);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM staff_profiles WHERE tenant_id=? AND position<>\'主管\'', [blank.tenant_id]).count, 0);
  assert.equal(one(db, "SELECT role FROM users WHERE phone='13222514178'").role, 'platform_owner');
  assert.equal(summary.integrity.ok, true);
});
```

统一夹具在本任务增加 `retainedFixture()`：先用 `migrateRetainedTestData` 写入原测试账号和 mock 流程，再调用 `ensureTenantSchema`，使生产迁移测试与现有保留数据脚本使用同一数据来源。

```js
async function retainedFixture() {
  const db = await createFullTestDB();
  migrateRetainedTestData(db, { password: 'FixtureTest!123', now: '2026-08-19T00:00:00.000Z' });
  ensureTenantSchema(db);
  return db;
}
```

- [ ] **步骤 2：运行生产迁移测试并确认失败**

运行：`node --test --test-concurrency=1 test/multi-tenant-production-migration.test.js`

预期：FAIL，当前迁移只会创建没有租户的普通主管。

- [ ] **步骤 3：实现固定账号迁移并移除旧启动入口**

`applyProductionTenantMigration` 的事务顺序固定为：迁移原数据到测试租户 → 创建平台管理员 → 创建空白租户 → 创建“发财”唯一主管及主管档案 → 运行 `assertTenantIntegrity` → 提交。空白租户不得创建默认小区、班次模板、绩效规则、邀请码、工单或普通人员。

`index-new.js` 删除 `runStartupStandaloneManager`，保留显式 CLI 迁移。生产服务不得通过启动环境变量静默创建或提权账号。

- [ ] **步骤 4：运行固定账号、保留数据和启动回归测试**

运行：`node --test --test-concurrency=1 test/multi-tenant-production-migration.test.js test/retained-test-data.test.js test/prepare-retained-test-data.test.js test/server-app.test.js`

预期：全部 PASS；测试租户原数据计数不减少，发财租户除主管档案外业务计数均为 0。

- [ ] **步骤 5：提交**

```bash
git add services/tenant-migration.js scripts/migrate-multi-tenant.js index-new.js test/multi-tenant-production-migration.test.js test/helpers/tenant-fixture.js
git rm services/startup-standalone-manager.js services/standalone-manager.js test/startup-standalone-manager.test.js test/standalone-manager.test.js
git commit -m "feat: 迁移测试企业并创建空白发财企业"
```

### 任务 12：补齐 API、安全文档和生产配置

**文件：**
- 修改：`docs/API.md`
- 修改：`docs/SECURITY-AUDIT.md`
- 修改：`README.md`
- 修改：`render.yaml`
- 修改：`介绍.md`
- 创建：`test/multi-tenant-docs.test.js`

- [ ] **步骤 1：编写文档完整性测试**

```js
test('生产文档包含平台初始化、迁移、回滚和租户隔离规则', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const api = fs.readFileSync('docs/API.md', 'utf8');
  const security = fs.readFileSync('docs/SECURITY-AUDIT.md', 'utf8');
  assert.match(readme, /tenant:dry-run/);
  assert.match(readme, /MIGRATE-MULTI-TENANT/);
  assert.match(api, /\/api\/platform\/applications/);
  assert.match(security, /跨租户读取返回 404/);
  assert.doesNotMatch(`${readme}${api}${security}`, /OwnerSecure!123|BlankSecure!123/);
});
```

- [ ] **步骤 2：运行文档测试并确认失败**

运行：`node --test --test-concurrency=1 test/multi-tenant-docs.test.js`

预期：FAIL，文档尚未记录平台接口和迁移命令。

- [ ] **步骤 3：更新文档和配置**

文档必须明确生产顺序：停止写入 → 下载并校验 Supabase 快照 → 本地 dry-run → 保存迁移前备份 → apply → 运行验收脚本 → 上传新快照 → 部署 → 验证三个固定账号 → 保留旧快照。环境变量只列名称和用途，不给示例真密钥：`PLATFORM_PROVISIONING_SECRET`、`PLATFORM_OWNER_PASSWORD`、`BLANK_SUPERVISOR_PASSWORD`、`JWT_SECRET`、Supabase 服务端配置。

`docs/API.md` 为每个平台接口写明方法、路径、角色、请求字段、成功响应和 400/401/403/404/409 响应。`介绍.md` 更新为平台—企业—主管—四人团队层级，不再描述全局主管。

- [ ] **步骤 4：运行文档、安全和配置测试**

运行：`node --test --test-concurrency=1 test/multi-tenant-docs.test.js test/security-audit.test.js test/render-persistence-config.test.js test/config-env.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add docs/API.md docs/SECURITY-AUDIT.md README.md render.yaml 介绍.md test/multi-tenant-docs.test.js
git commit -m "docs: 补充多企业安全运维和 API 文档"
```

### 任务 13：执行全系统安全验收和生产迁移演练

**文件：**
- 创建：`scripts/verify-multi-tenant.js`
- 修改：`package.json`
- 创建：`test/verify-multi-tenant.test.js`

- [ ] **步骤 1：编写验收脚本测试**

```js
test('多租户验收摘要覆盖固定账号、空白企业和孤立数据', async () => {
  const db = await retainedFixture();
  await applyProductionTenantMigration(db, {
    testSupervisorPhone: '13800000001',
    platformOwnerPhone: '13222514178', platformOwnerName: '句子工单管理员', platformOwnerPassword: 'FixtureOwner!123',
    blankSupervisorPhone: '17713302589', blankSupervisorName: '发财', blankSupervisorPassword: 'FixtureBlank!123',
    blankTenantName: '发财企业',
  });
  const summary = verifyMultiTenant(db);
  assert.deepEqual(summary.accounts, {
    platformOwner: true, testSupervisor: true, blankSupervisor: true,
  });
  assert.equal(summary.blankTenant.businessRows, 0);
  assert.equal(summary.integrity.ok, true);
  assert.equal(summary.crossTenantLeaks.length, 0);
});
```

- [ ] **步骤 2：运行验收测试并确认失败**

运行：`node --test --test-concurrency=1 test/verify-multi-tenant.test.js`

预期：FAIL，验收脚本不存在。

- [ ] **步骤 3：实现只读验收脚本**

```js
function verifyMultiTenant(db) {
  const accounts = {
    platformOwner: Boolean(one(db, "SELECT id FROM users WHERE phone='13222514178' AND role='platform_owner' AND tenant_id=''")),
    testSupervisor: Boolean(one(db, "SELECT id FROM users WHERE phone='13800000001' AND role='主管' AND tenant_id<>''")),
    blankSupervisor: Boolean(one(db, "SELECT id FROM users WHERE phone='17713302589' AND role='主管' AND tenant_id<>''")),
  };
  return { accounts, integrity: assertTenantIntegrity(db), blankTenant: inspectBlankTenant(db), crossTenantLeaks: inspectRelationships(db) };
}
```

脚本只读数据库并以非零退出码报告：空 `tenant_id`、企业主管数量异常、跨租户外键、发财租户出现业务数据、平台管理员绑定租户、测试账号丢失。输出不能包含密码哈希或密钥。

- [ ] **步骤 4：运行全部自动化验证**

运行：

```bash
npm test
npm run tenant:dry-run
npm run verify:multi-tenant
```

预期：所有测试 PASS；dry-run 显示 0 个冲突；验收摘要 `integrity.ok=true`、`crossTenantLeaks=[]`。

- [ ] **步骤 5：检查提交和敏感信息**

运行：

```bash
git diff --check
git status --short
rg -n "PLATFORM_OWNER_PASSWORD=|BLANK_SUPERVISOR_PASSWORD=|PLATFORM_PROVISIONING_SECRET=|SUPABASE_SERVICE_ROLE_KEY=" . --glob '!node_modules/**' --glob '!data.db*'
```

预期：`git diff --check` 无输出；只出现环境变量名称或文档说明，不出现真实值。

- [ ] **步骤 6：提交**

```bash
git add scripts/verify-multi-tenant.js package.json test/verify-multi-tenant.test.js
git commit -m "test: 增加多企业生产安全验收"
```

## 生产部署检查点

代码合并前必须满足：全量测试通过、迁移 dry-run 无冲突、数据库快照已备份、平台管理员和两个主管密码通过 Render Secret 注入。生产 apply 属于不可自动推断的外部状态变更，只能在用户明确授权后执行。迁移后先访问 `/api/health` 和 `/api/persistence/status`，再分别验证平台账号、测试主管、空白主管；任何一步失败立即停止写入并恢复迁移前 Supabase 快照。
