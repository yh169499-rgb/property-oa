# 人员组织、排班考勤与报告优化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在保留现有 Express、sql.js 和原生前端的基础上，实现服务端人员主数据、自定义单线组织树、真实排班考勤、主管工作台、响应式日历、按人员报告和准确的月度工单统计。

**架构：** 新增小而专注的 schema、组织、排班、考勤、活动日志和统计服务，路由只负责参数解析与响应。前端保留无构建单页应用，通过独立的全局模块实现“我的”“管理工作台”“响应式日历”和人员报告；旧 `public/app.js` 只负责导航与既有工单流程集成。

**技术栈：** Node.js 24、CommonJS、Express 4、sql.js、JWT、原生 `node:test`、原生 HTML/CSS/JavaScript、ECharts。

---

## 计划依据

- 设计规格：`docs/superpowers/specs/2026-07-30-workforce-attendance-reporting-design.md`
- 当前服务入口：`index-new.js`
- 当前数据库封装：`db.js`
- 当前前端入口：`public/index.html`、`public/app.js`
- 当前 API 封装：`public/js/api.js`

## 文件结构决策

### 服务端新增文件

| 文件 | 单一职责 |
| --- | --- |
| `server-app.js` | 创建并配置 Express 应用，不负责监听端口 |
| `workforce-schema.js` | 创建人员、班次、考勤、日志表及兼容字段 |
| `services/workforce-migration.js` | 从现有用户、工单和浏览器导入数据迁移到新模型 |
| `services/organization.js` | 组织树、循环检测和递归团队范围 |
| `services/ticket-activity.js` | 工单动作识别、日志写入和动作查询 |
| `services/shifts.js` | 班次规范化、批量排班和冲突检测 |
| `services/attendance.js` | 签到签退、考勤状态计算和修正 |
| `services/calendar.js` | 聚合人员、班次、考勤、工单和冲突 |
| `services/reporting.js` | 月度边界、主管统计和人员报告 |
| `routes/profiles.js` | 当前用户、人员档案和组织 API |
| `routes/shifts.js` | 班次模板与排班 API |
| `routes/attendance.js` | 签到、签退、查询和修正 API |
| `routes/workforce-reports.js` | 日历、看板和人员报告 API |

### 前端新增文件

| 文件 | 单一职责 |
| --- | --- |
| `public/js/workforce-api.js` | 新增人员、组织、班次、考勤、日历和报告请求 |
| `public/js/my-page.js` | 主管和普通人员“我的”页面 |
| `public/js/management-workspace.js` | 人员组织、排班、考勤、注册审核、报告和设置标签页 |
| `public/js/responsive-calendar.js` | 桌面日视图和窄屏人员议程 |
| `public/js/staff-report.js` | 人员报告筛选、预览和导出 |
| `public/js/workforce-utils.js` | 浏览器与 Node 共用的日期、响应式和显示工具 |

### 测试新增文件

| 文件 | 覆盖内容 |
| --- | --- |
| `test/helpers/test-db.js` | 创建内存 sql.js 数据库 |
| `test/helpers/http-server.js` | 在随机端口启动/关闭 Express 应用 |
| `test/server-app.test.js` | 可测试服务入口和健康检查 |
| `test/workforce-schema.test.js` | 新表、字段、索引和幂等迁移 |
| `test/workforce-migration.test.js` | 用户档案和历史负责人回填 |
| `test/organization.test.js` | 循环检测、组织树和递归团队 |
| `test/profiles-api.test.js` | 当前用户、人员档案和直属上级 API |
| `test/ticket-activity.test.js` | 动作日志和稳定负责人关联 |
| `test/shifts.test.js` | 普通/跨夜班次、批量排班和冲突 |
| `test/attendance.test.js` | 打卡状态、幂等、补卡和审计 |
| `test/calendar.test.js` | 日历聚合和冲突输出 |
| `test/reporting.test.js` | 上海时区、本月统计、人员和主管报告 |
| `test/workforce-utils.test.js` | 前端纯工具函数 |

## 实施约束

- 开始任务 1 前使用 `using-git-worktrees` 创建 `codex/workforce-attendance` 专用工作树；当前主工作区已有未提交换行符变更，禁止直接在其中实施或清理这些用户变更。
- 每个任务先写失败测试，再写最少实现。
- 测试统一串行执行，避免共享数据库单例相互污染。
- 所有日期边界统一由 `services/reporting.js` 生成。
- 所有考勤时间以服务端时间为准，路由不接受客户端伪造的当前时间；测试通过服务函数的 `now` 参数注入固定时间。
- 新路由统一使用 `requireAuth`；人员管理、组织调整、排班和考勤修正使用 `requireAdmin`。
- 旧工单接口保持兼容，不在本计划中完成全部历史安全整改。
- 不修改或删除现有 `worker` 姓名字段。
- 不把 `.superpowers/` 视觉原型加入功能提交。

### 任务 1：建立可测试的服务入口

**文件：**
- 创建：`server-app.js`
- 创建：`test/helpers/http-server.js`
- 创建：`test/server-app.test.js`
- 修改：`index-new.js:4-60`
- 修改：`package.json:6-13`

- [ ] **步骤 1：添加测试命令**

将脚本扩展为：

```json
{
  "scripts": {
    "start": "node index-new.js",
    "start:legacy": "node index.js",
    "dev": "node index-new.js",
    "migrate": "node migrate-passwords.js",
    "test": "node --test --test-concurrency=1",
    "test:workforce": "node --test --test-concurrency=1 test/*workforce*.test.js test/organization.test.js test/shifts.test.js test/attendance.test.js test/calendar.test.js test/reporting.test.js"
  }
}
```

- [ ] **步骤 2：编写失败的服务入口测试**

```js
// test/server-app.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHttpServer } = require('./helpers/http-server');

test('GET / serves the application from a testable app', async (t) => {
  const server = await startHttpServer();
  t.after(() => server.close());
  const response = await fetch(`${server.url}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(await response.text(), /工单系统/);
});
```

- [ ] **步骤 3：运行测试并确认失败**

运行：

```bash
node --test --test-name-pattern="testable app" test/server-app.test.js
```

预期：FAIL，提示 `Cannot find module '../server-app'` 或测试辅助文件不存在。

- [ ] **步骤 4：实现 Express 工厂和测试服务器**

`server-app.js` 导出不监听端口的应用：

```js
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { verifyToken } = require('./middleware/auth');

function createServerApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(verifyToken);
  const limiter = rateLimit({ windowMs: 60_000, max: 5 });
  app.use('/api/login', limiter);
  app.use('/api/register', limiter);
  app.use('/api/reset-password', limiter);
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(require('./config').UPLOAD_DIR));
  app.use('/api', require('./routes/auth'));
  app.use('/api/tickets', require('./routes/tickets'));
  app.use('/api/communities', require('./routes/communities'));
  app.use('/api/staff', require('./routes/staff'));
  app.use('/api', require('./routes/settings'));
  return app;
}

module.exports = { createServerApp };
```

`test/helpers/http-server.js`：

```js
const { createServerApp } = require('../../server-app');

async function startHttpServer() {
  const app = createServerApp();
  const listener = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const { port } = listener.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => listener.close(resolve))
  };
}

module.exports = { startHttpServer };
```

`index-new.js` 只调用 `initDB()`、`createServerApp()` 和 `listen()`。

- [ ] **步骤 5：运行测试**

运行：

```bash
node --test --test-name-pattern="testable app" test/server-app.test.js
```

预期：1 个测试 PASS。

- [ ] **步骤 6：提交**

```bash
git add package.json index-new.js server-app.js test/helpers/http-server.js test/server-app.test.js
git commit -m "test: add testable express application"
```

### 任务 2：创建人员、班次、考勤和日志数据库结构

**文件：**
- 创建：`workforce-schema.js`
- 创建：`test/helpers/test-db.js`
- 创建：`test/workforce-schema.test.js`
- 修改：`db.js:8-162`
- 修改：`test/helpers/http-server.js`

- [ ] **步骤 1：编写 schema 失败测试**

测试应创建内存数据库、先建立当前 `users` 和 `tickets` 最小表，再执行两次 `ensureWorkforceSchema(db)`：

```js
test('workforce schema is idempotent and adds required tables', async () => {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  ensureWorkforceSchema(db);
  const names = tableNames(db);
  for (const name of [
    'staff_profiles', 'shift_templates', 'shift_assignments',
    'attendance_records', 'attendance_change_logs', 'ticket_activity_logs',
    'workforce_import_batches'
  ]) assert.equal(names.includes(name), true);
  assert.equal(columnNames(db, 'tickets').includes('assignee_user_id'), true);
  assert.equal(columnNames(db, 'tickets').includes('assigned_at'), true);
});
```

- [ ] **步骤 2：运行 schema 测试并确认失败**

```bash
node --test --test-concurrency=1 test/workforce-schema.test.js
```

预期：FAIL，提示 `ensureWorkforceSchema is not a function`。

- [ ] **步骤 3：实现 `workforce-schema.js`**

实现并导出：

```js
function ensureWorkforceSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS staff_profiles (...)`);
  db.run(`CREATE TABLE IF NOT EXISTS shift_templates (...)`);
  db.run(`CREATE TABLE IF NOT EXISTS shift_assignments (...)`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance_records (...)`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance_change_logs (...)`);
  db.run(`CREATE TABLE IF NOT EXISTS ticket_activity_logs (...)`);
  db.run(`CREATE TABLE IF NOT EXISTS workforce_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_key TEXT UNIQUE NOT NULL,
    imported_by INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    summary_json TEXT DEFAULT '{}'
  )`);
  addColumn(db, 'tickets', 'assignee_user_id INTEGER');
  addColumn(db, 'tickets', "assigned_at TEXT DEFAULT ''");
  db.run('CREATE INDEX IF NOT EXISTS idx_staff_manager ON staff_profiles(manager_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_shift_staff_date ON shift_assignments(staff_id, work_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_attendance_staff_date ON attendance_records(staff_id, work_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ticket_activity_actor_time ON ticket_activity_logs(actor_staff_id, created_at)');
}
```

六张业务表的字段必须与批准规格第 5 节一致；`workforce_import_batches` 是规格第 13.4 节“记录导入版本”的落表实现。为 `shift_assignments` 和 `attendance_records` 建立 `UNIQUE(staff_id, work_date)`。

`addColumn` 使用 PRAGMA 检查，避免依赖异常文本：

```js
function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  const result = db.exec(`PRAGMA table_info(${table})`);
  const existing = result[0] ? result[0].values.map(row => row[1]) : [];
  if (!existing.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
```

- [ ] **步骤 4：接入数据库初始化和测试注入**

在 `db.js`：

```js
const { ensureWorkforceSchema } = require('./workforce-schema');

function setDBForTests(value) {
  db = value;
}
```

在旧表与旧字段初始化完成后调用 `ensureWorkforceSchema(db)`，导出 `setDBForTests`。

修改 `test/helpers/http-server.js`，允许路由测试注入内存数据库：

```js
async function startHttpServer(testDb) {
  if (testDb) require('../../db').setDBForTests(testDb);
  const app = createServerApp();
  const listener = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const { port } = listener.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => listener.close(resolve))
  };
}
```

- [ ] **步骤 5：运行测试**

```bash
node --test --test-concurrency=1 test/workforce-schema.test.js
```

预期：schema 幂等、表和字段检查全部 PASS。

- [ ] **步骤 6：运行现有 JavaScript 语法检查**

```bash
find . -maxdepth 3 -name '*.js' -not -path './node_modules/*' -print0 | xargs -0 -n1 node --check
```

预期：退出码 0。

- [ ] **步骤 7：提交**

```bash
git add db.js workforce-schema.js test/helpers/test-db.js test/helpers/http-server.js test/workforce-schema.test.js
git commit -m "feat: add workforce database schema"
```

### 任务 3：迁移现有用户和历史工单负责人

**文件：**
- 创建：`services/workforce-migration.js`
- 创建：`test/workforce-migration.test.js`
- 修改：`db.js:126-133`

- [ ] **步骤 1：编写迁移失败测试**

覆盖：

- 每个用户只创建一个 `staff_profiles`。
- `admin/lead` 映射职位“主管”。
- `worker` 映射职位“维修师傅”。
- `keeper` 映射职位“物业管家”。
- 姓名唯一时回填 `tickets.assignee_user_id`。
- 同名或无匹配时保持 NULL。

核心断言：

```js
assert.equal(profileCount, 3);
assert.equal(ticket.assignee_user_id, workerUserId);
assert.equal(unmatchedTicket.assignee_user_id, null);
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
node --test --test-concurrency=1 test/workforce-migration.test.js
```

预期：FAIL，提示迁移模块不存在。

- [ ] **步骤 3：实现幂等迁移**

导出：

```js
function migrateUsersToProfiles(db, nowIso) {}
function backfillTicketAssignees(db) {}
function listUnmatchedAssignees(db) {}
```

档案使用 `INSERT OR IGNORE ... SELECT ... FROM users`；工单回填只匹配唯一姓名：

```sql
UPDATE tickets
SET assignee_user_id = (
  SELECT sp.user_id
  FROM staff_profiles sp
  WHERE sp.name = tickets.worker
)
WHERE worker <> ''
  AND assignee_user_id IS NULL
  AND 1 = (
    SELECT COUNT(*) FROM staff_profiles sp WHERE sp.name = tickets.worker
  )
```

- [ ] **步骤 4：在初始化时执行迁移**

`db.js` 顺序固定为：

```text
旧表初始化
→ workforce schema
→ 用户档案迁移
→ 历史工单负责人回填
→ 默认小区
→ saveDB
```

- [ ] **步骤 5：运行测试**

```bash
node --test --test-concurrency=1 test/workforce-schema.test.js test/workforce-migration.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add db.js services/workforce-migration.js test/workforce-migration.test.js
git commit -m "feat: migrate users into workforce profiles"
```

### 任务 4：实现人员档案和组织树

**文件：**
- 创建：`services/organization.js`
- 创建：`routes/profiles.js`
- 创建：`test/helpers/auth.js`
- 创建：`test/organization.test.js`
- 创建：`test/profiles-api.test.js`
- 修改：`server-app.js`

- [ ] **步骤 1：编写组织纯函数测试**

测试数据：

```js
const profiles = [
  { id: 1, name: '主管', manager_id: null },
  { id: 2, name: '组长', manager_id: 1 },
  { id: 3, name: '师傅', manager_id: 2 },
  { id: 4, name: '未分配人员', manager_id: null }
];
```

断言：

```js
assert.deepEqual(descendantIds(profiles, 1), [2, 3]);
assert.equal(wouldCreateCycle(profiles, 1, 3), true);
assert.equal(wouldCreateCycle(profiles, 3, 1), false);
assert.equal(buildOrganizationTree(profiles).unassigned[0].id, 4);
```

- [ ] **步骤 2：运行组织测试并确认失败**

```bash
node --test test/organization.test.js
```

预期：FAIL，提示 `services/organization.js` 不存在。

- [ ] **步骤 3：实现组织服务**

导出：

```js
function descendantIds(profiles, managerId) {}
function wouldCreateCycle(profiles, staffId, managerId) {}
function buildOrganizationTree(profiles) {}
function updateManager(db, staffId, managerId) {}
```

`updateManager` 在循环时抛出：

```js
const error = new Error('不能把本人或下级设为直属上级');
error.status = 409;
error.code = 'ORGANIZATION_CYCLE';
error.details = { staffId, managerId, path };
throw error;
```

- [ ] **步骤 4：编写人员 API 失败测试**

用测试数据库生成 JWT，覆盖：

- 未登录访问 `/api/me` 返回 401。
- 登录后返回本人档案。
- 本人只能修改 `phone` 和 `birth_month`。
- 主管可以修改职位、入职日期、技能和直属上级。
- 循环上级返回 409。
- `/api/organization/tree` 返回树与未分配人员。

`test/helpers/auth.js` 固定使用运行时配置签发测试 Token：

```js
const jwt = require('jsonwebtoken');
const config = require('../../config');

function authHeader(user) {
  const token = jwt.sign(user, config.JWT_SECRET, { expiresIn: '5m' });
  return { Authorization: `Bearer ${token}` };
}

module.exports = { authHeader };
```

- [ ] **步骤 5：实现 `routes/profiles.js`**

路由：

```text
GET   /api/me
PATCH /api/me
GET   /api/staff/profiles
GET   /api/staff/profiles/:id
POST  /api/staff/profiles
PATCH /api/staff/profiles/:id
GET   /api/organization/tree
PATCH /api/staff/profiles/:id/manager
GET   /api/staff/profiles/:id/team
```

统一错误响应：

```js
res.status(error.status || 500).json({
  error: error.message,
  code: error.code || 'INTERNAL_ERROR',
  details: error.details || {}
});
```

- [ ] **步骤 6：挂载并运行测试**

在 `server-app.js`：

```js
app.use('/api', require('./routes/profiles'));
```

运行：

```bash
node --test --test-concurrency=1 test/organization.test.js test/profiles-api.test.js
```

预期：全部 PASS。

- [ ] **步骤 7：提交**

```bash
git add server-app.js services/organization.js routes/profiles.js test/helpers/auth.js test/organization.test.js test/profiles-api.test.js
git commit -m "feat: add staff profiles and organization tree"
```

### 任务 5：记录工单操作日志和稳定负责人

**文件：**
- 创建：`services/ticket-activity.js`
- 创建：`test/ticket-activity.test.js`
- 修改：`routes/tickets.js:29-172`
- 修改：`public/app.js:78-93,932-1059`

- [ ] **步骤 1：编写动作识别失败测试**

覆盖：

```js
assert.equal(detectTicketAction(before, { worker: '张师傅', status: 'doing' }), 'assign');
assert.equal(detectTicketAction(confirm, { status: 'done' }), 'approve_complete');
assert.equal(detectTicketAction(confirm, { status: 'doing', rejectReason: '材料不足' }), 'reject');
assert.equal(detectTicketAction(doing, { status: 'pending' }), 'suspend');
assert.equal(detectTicketAction(pending, { status: 'doing' }), 'resume');
assert.equal(detectTicketAction(doing, { _action: 'urge' }), 'urge');
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
node --test test/ticket-activity.test.js
```

预期：FAIL，提示动作服务不存在。

- [ ] **步骤 3：实现日志服务**

导出：

```js
function detectTicketAction(before, updates) {}
function resolveAssigneeUserId(db, workerName) {}
function recordTicketActivity(db, {
  ticketId, actorUserId, actorStaffId, action, metadata, createdAt
}) {}
```

无法唯一匹配负责人姓名时返回 NULL，不猜测用户。

`_action` 不是数据库字段，只允许值 `urge`；其他动作必须根据状态和负责人变化推导。服务端在生成 SQL `SET` 前删除 `_action`，防止把控制字段写入工单表。

- [ ] **步骤 4：接入工单 PATCH**

在更新前读取 `before`，更新后：

- `worker` 变化时同步 `assignee_user_id` 和 `assigned_at`。
- 登录用户存在且识别出动作时写入日志。
- 没有 Token 的旧调用继续完成原更新，但不生成伪造操作人日志。

- [ ] **步骤 5：确保前端主管动作携带 Token**

将派单、催办、驳回、确认、搁置、恢复、提交结果统一调用现有 `apiPatch()` 或 `API.patch()`；直接 `fetch` 必须添加 `Authorization`。催办显式发送：

```js
apiPatch(ticket.id, {
  metadata: JSON.stringify(metadata),
  _action: 'urge'
});
```

- [ ] **步骤 6：运行测试与语法检查**

```bash
node --test --test-concurrency=1 test/ticket-activity.test.js
node --check routes/tickets.js
node --check public/app.js
```

预期：全部退出 0。

- [ ] **步骤 7：提交**

```bash
git add services/ticket-activity.js routes/tickets.js public/app.js test/ticket-activity.test.js
git commit -m "feat: record ticket workflow activity"
```

### 任务 6：实现班次模板和每日排班

**文件：**
- 创建：`services/shifts.js`
- 创建：`routes/shifts.js`
- 创建：`test/shifts.test.js`
- 修改：`server-app.js`

- [ ] **步骤 1：编写班次服务失败测试**

覆盖：

- `08:00-18:00` 普通班次。
- `22:00-06:00` 跨夜班次结束时间落在次日。
- 一人一天只能一个有效安排。
- 批量排班按日期和人员展开。
- 同一人员重复安排返回 `SHIFT_ALREADY_EXISTS`。

示例：

```js
assert.deepEqual(resolveShiftWindow('2026-07-30', '22:00', '06:00'), {
  startAt: '2026-07-30T22:00:00+08:00',
  endAt: '2026-07-31T06:00:00+08:00'
});
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
node --test test/shifts.test.js
```

预期：FAIL，提示班次服务不存在。

- [ ] **步骤 3：实现班次服务**

导出：

```js
function resolveShiftWindow(workDate, startTime, endTime) {}
function validateAssignment(input) {}
function createAssignment(db, input, operatorUserId) {}
function createBatchAssignments(db, input, operatorUserId) {}
function listAssignments(db, filters) {}
```

批量输入固定为：

```json
{
  "staffIds": [2, 3],
  "dates": ["2026-07-30", "2026-07-31"],
  "assignmentType": "work",
  "templateId": 1,
  "overwrite": false
}
```

- [ ] **步骤 4：实现排班路由**

路由：

```text
GET    /api/shift-templates
POST   /api/shift-templates
PATCH  /api/shift-templates/:id
GET    /api/shifts
POST   /api/shifts
POST   /api/shifts/batch
PATCH  /api/shifts/:id
DELETE /api/shifts/:id
```

所有写路由使用 `requireAdmin`。冲突返回 409，并在 `details.conflicts` 中列出人员和日期。

- [ ] **步骤 5：挂载并运行测试**

```bash
node --test --test-concurrency=1 test/shifts.test.js
```

预期：普通、跨夜、批量和冲突测试全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add server-app.js services/shifts.js routes/shifts.js test/shifts.test.js
git commit -m "feat: add workforce shift scheduling"
```

### 任务 7：实现签到、签退和考勤修正

**文件：**
- 创建：`services/attendance.js`
- 创建：`routes/attendance.js`
- 创建：`test/attendance.test.js`
- 修改：`server-app.js`

- [ ] **步骤 1：编写考勤状态失败测试**

固定班次 `08:00-18:00`，宽限 5 分钟，覆盖：

```js
assert.equal(calculateAttendanceStatus(shift, '07:58', '18:01'), 'normal');
assert.equal(calculateAttendanceStatus(shift, '08:06', '18:01'), 'late');
assert.equal(calculateAttendanceStatus(shift, '07:58', '17:54'), 'early_leave');
assert.equal(calculateAttendanceStatus(shift, '08:06', '17:54'), 'late_and_early');
assert.equal(calculateAttendanceStatus(shift, null, null, { settled: true }), 'absent');
assert.equal(calculateAttendanceStatus(restShift, null, null), 'rest');
assert.equal(calculateAttendanceStatus(leaveShift, null, null), 'leave');
```

- [ ] **步骤 2：编写打卡幂等与修正审计测试**

断言：

- 无排班签到抛 `SHIFT_NOT_FOUND`。
- 第二次签到返回第一次时间。
- 未签到不能签退。
- 跨夜班次次日签退归属原工作日。
- 修正必须提供原因。
- 修正写入 `attendance_change_logs`。

- [ ] **步骤 3：运行测试并确认失败**

```bash
node --test test/attendance.test.js
```

预期：FAIL，提示考勤服务不存在。

- [ ] **步骤 4：实现考勤服务**

导出：

```js
function calculateAttendanceStatus(shift, checkInAt, checkOutAt, options = {}) {}
function checkIn(db, staffId, nowIso) {}
function checkOut(db, staffId, nowIso) {}
function correctAttendance(db, attendanceId, patch, operatorUserId, reason, nowIso) {}
function listAttendance(db, filters) {}
```

时间比较先转换为绝对时间戳，不使用字符串比较。

- [ ] **步骤 5：实现考勤路由**

```text
POST  /api/attendance/check-in
POST  /api/attendance/check-out
GET   /api/attendance
PATCH /api/attendance/:id/correct
GET   /api/attendance/:id/changes
```

签到签退从 `req.user.id` 找人员档案，不接受客户端 `staff_id` 冒充他人。修正接口使用 `requireAdmin`。

- [ ] **步骤 6：挂载并运行测试**

```bash
node --test --test-concurrency=1 test/attendance.test.js
```

预期：全部 PASS。

- [ ] **步骤 7：提交**

```bash
git add server-app.js services/attendance.js routes/attendance.js test/attendance.test.js
git commit -m "feat: add schedule based attendance"
```

### 任务 8：实现统一日历数据接口

**文件：**
- 创建：`services/calendar.js`
- 创建：`routes/workforce-reports.js`
- 创建：`test/calendar.test.js`
- 修改：`server-app.js`

- [ ] **步骤 1：编写日历聚合失败测试**

准备两名人员、三张工单、班次和请假，断言返回：

```js
assert.equal(result.people.length, 2);
assert.equal(result.people[0].shift.assignmentType, 'work');
assert.equal(result.people[1].shift.assignmentType, 'leave');
assert.equal(result.events[0].ticketId, 'WX1001');
assert.equal(result.conflicts[0].staffId, 2);
```

冲突只在同一人员的时间块重叠时产生。

- [ ] **步骤 2：运行测试并确认失败**

```bash
node --test test/calendar.test.js
```

预期：FAIL，提示日历服务不存在。

- [ ] **步骤 3：实现日历服务**

导出：

```js
function estimateTicketWindow(ticket, staffHistory, now) {}
function detectCalendarConflicts(events) {}
function buildDayCalendar(db, {
  date, staffId, managerId, communityId, viewerUserId
}) {}
```

响应结构：

```json
{
  "date": "2026-07-30",
  "people": [],
  "events": [],
  "conflicts": [],
  "generatedAt": "2026-07-30T09:30:00+08:00"
}
```

- [ ] **步骤 4：实现并挂载日历路由**

在 `routes/workforce-reports.js`：

```text
GET /api/calendar/day
```

要求登录。非主管忽略请求中的其他 `staff_id` 和 `manager_id`，强制只返回本人。

- [ ] **步骤 5：运行测试**

```bash
node --test --test-concurrency=1 test/calendar.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add server-app.js services/calendar.js routes/workforce-reports.js test/calendar.test.js
git commit -m "feat: add unified workforce calendar feed"
```

### 任务 9：实现月度看板和人员/主管报告

**文件：**
- 创建：`services/reporting.js`
- 创建：`test/reporting.test.js`
- 修改：`routes/workforce-reports.js`
- 修改：`routes/settings.js:130-143`

- [ ] **步骤 1：编写上海时区边界失败测试**

```js
assert.deepEqual(shanghaiMonthRange('2026-07-30T12:00:00+08:00'), {
  from: '2026-06-30T16:00:00.000Z',
  toExclusive: '2026-07-31T16:00:00.000Z'
});
```

增加工单分别位于月初前一毫秒、月初、月末和下月月初，断言只计入中间两张。

- [ ] **步骤 2：编写报告双口径失败测试**

准备：

- 上月派单、本月完成。
- 本月派单、尚未完成。
- 本月派单、本月完成。

断言：

```js
assert.equal(report.received.total, 2);
assert.equal(report.completed.total, 2);
assert.equal(report.completed.onTimeRate, 100);
```

- [ ] **步骤 3：编写主管动作与递归团队测试**

主管有组长、师傅两级下属，断言：

- 个人动作只计算 `actor_staff_id = 主管`。
- 团队成果包含组长和师傅。
- 不包含组织树外人员。

- [ ] **步骤 4：运行测试并确认失败**

```bash
node --test test/reporting.test.js
```

预期：FAIL，提示报告服务不存在。

- [ ] **步骤 5：实现报告服务**

导出：

```js
function shanghaiDayRange(date) {}
function shanghaiMonthRange(nowIso) {}
function inclusiveDateRange(from, to) {}
function getDashboardStats(db, filters) {}
function getStaffReport(db, staffId, filters) {}
function getManagerReport(db, staffId, filters) {}
```

`inclusiveDateRange('2026-07-01', '2026-07-30')` 返回 7 月 1 日起点和 7 月 31 日排他终点。

- [ ] **步骤 6：实现报告路由**

```text
GET /api/dashboard/stats
GET /api/reports/staff/:staff_id
GET /api/reports/manager/:staff_id
GET /api/me/stats
GET /api/me/attendance
```

保留 `/api/report`，扩展可选 `staff_id` 参数并复用 `getStaffReport()`；没有 `staff_id` 时保持旧响应兼容。

- [ ] **步骤 7：运行测试**

```bash
node --test --test-concurrency=1 test/reporting.test.js
```

预期：月界、双口径、递归团队和结束日测试全部 PASS。

- [ ] **步骤 8：提交**

```bash
git add services/reporting.js routes/workforce-reports.js routes/settings.js test/reporting.test.js
git commit -m "feat: add accurate workforce reporting"
```

### 任务 10：增加前端工作力 API 和导航骨架

**文件：**
- 创建：`public/js/workforce-api.js`
- 创建：`public/js/workforce-utils.js`
- 创建：`test/workforce-utils.test.js`
- 修改：`public/index.html:103-340,418-424`
- 修改：`public/app.js:129-238,1390-1406`

- [ ] **步骤 1：编写前端纯工具测试**

`workforce-utils.js` 使用 UMD 形式同时支持浏览器和 Node：

```js
const utils = typeof module === 'object' ? require('../public/js/workforce-utils') : window.WorkforceUtils;
assert.equal(utils.isNarrowViewport(767), true);
assert.equal(utils.isNarrowViewport(1024), false);
assert.equal(utils.periodLabel('month'), '本月');
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
node --test test/workforce-utils.test.js
```

预期：FAIL，提示工具模块不存在。

- [ ] **步骤 3：实现 `WorkforceAPI`**

统一基于现有 `API.request()`：

```js
window.WorkforceAPI = {
  me: () => API.get('/api/me'),
  updateMe: body => API.patch('/api/me', body),
  organizationTree: () => API.get('/api/organization/tree'),
  profiles: () => API.get('/api/staff/profiles'),
  dayCalendar: query => API.get('/api/calendar/day?' + new URLSearchParams(query)),
  checkIn: () => API.post('/api/attendance/check-in', {}),
  checkOut: () => API.post('/api/attendance/check-out', {}),
  dashboardStats: communityId => API.get('/api/dashboard/stats?community_id=' + encodeURIComponent(communityId)),
  staffReport: (staffId, query) => API.get(`/api/reports/staff/${staffId}?${new URLSearchParams(query)}`)
};
```

- [ ] **步骤 4：重组导航和页面骨架**

主管导航：

```text
首页｜报修｜投诉｜帮助｜已完成｜管理工作台｜我的
```

新增：

```html
<section class="page" id="page-management"></section>
<section class="page" id="page-my"></section>
```

删除旧“师傅日程”导航入口，但先保留旧 DOM 直到任务 12 接管完成。

- [ ] **步骤 5：按顺序加载脚本**

```html
<script src="js/workforce-utils.js"></script>
<script src="js/workforce-api.js"></script>
<script src="js/responsive-calendar.js"></script>
<script src="js/staff-report.js"></script>
<script src="js/my-page.js"></script>
<script src="js/management-workspace.js"></script>
<script src="app.js"></script>
```

对于尚未创建的后四个脚本，本步骤先创建最小空模块：

```js
window.ResponsiveCalendar = {};
```

- [ ] **步骤 6：运行工具测试和语法检查**

```bash
node --test test/workforce-utils.test.js
find public -maxdepth 2 -name '*.js' -print0 | xargs -0 -n1 node --check
```

预期：全部退出 0。

- [ ] **步骤 7：提交**

```bash
git add public/index.html public/app.js public/js/workforce-api.js public/js/workforce-utils.js public/js/responsive-calendar.js public/js/staff-report.js public/js/my-page.js public/js/management-workspace.js test/workforce-utils.test.js
git commit -m "feat: add workforce frontend shell"
```

### 任务 11：实现主管首页和“我的”

**文件：**
- 修改：`public/js/my-page.js`
- 修改：`public/app.js:198-345,1123-1125,1208-1248`
- 修改：`public/index.html`
- 修改：`public/styles.css`

- [ ] **步骤 1：实现可复测的渲染输入函数**

在 `my-page.js` 中先写纯函数：

```js
function buildMyPageModel(profile, stats, attendance, period) {
  return {
    profile,
    personalActions: stats.personalActions[period],
    teamResults: stats.teamResults[period],
    attendanceSummary: attendance.summary,
    days: attendance.days
  };
}
```

将函数暴露为 `window.MyPage.buildModel`，并在 CommonJS 环境导出供测试。

- [ ] **步骤 2：为模型编写失败测试**

在 `test/workforce-utils.test.js` 增加主管和师傅两组输入，断言主管有个人动作和团队成果，师傅只显示个人工单与考勤。

运行：

```bash
node --test test/workforce-utils.test.js
```

预期：新增断言 FAIL。

- [ ] **步骤 3：实现“我的”页面**

必须包含：

- 基本资料。
- 出生年月和手机号编辑。
- 今日/本月/本年切换。
- 主管个人动作。
- 主管团队成果。
- 今日打卡。
- 本月考勤汇总。
- 月历明细。

入职日期、职位和直属上级显示只读。

- [ ] **步骤 4：实现主管首页指挥中心**

用 `/api/dashboard/stats` 替换当前 `renderDashboard()` 中的全量本地统计，卡片名称明确为：

```text
本月工单总量
本月报修
本月投诉
本月帮助
当前紧急待处理
本月平均处理时长
本月按时完成率
```

首页额外显示今日主管动作、团队到岗和考勤异常。

- [ ] **步骤 5：实现页面样式**

CSS 必须包含：

- 指挥中心深蓝渐变头部。
- 响应式 KPI 网格。
- 资料卡。
- 周期切换。
- 考勤月历状态色。
- 1024px 和 768px 断点。

- [ ] **步骤 6：运行测试与语法检查**

```bash
node --test test/workforce-utils.test.js
node --check public/js/my-page.js
node --check public/app.js
```

预期：全部退出 0。

- [ ] **步骤 7：提交**

```bash
git add public/js/my-page.js public/app.js public/index.html public/styles.css test/workforce-utils.test.js
git commit -m "feat: add manager dashboard and my page"
```

### 任务 12：实现管理工作台和组织层级

**文件：**
- 修改：`public/js/management-workspace.js`
- 修改：`public/index.html`
- 修改：`public/styles.css`

- [ ] **步骤 1：实现工作台标签结构**

固定标签：

```js
const MANAGEMENT_TABS = [
  'organization',
  'schedule',
  'attendance',
  'registrations',
  'reports',
  'settings'
];
```

工作台初始化只加载当前标签数据，切换标签时再请求，避免一次拉取全部数据。

- [ ] **步骤 2：实现组织树**

节点显示：

- 姓名。
- 职位。
- 在岗状态。
- 直属人数。

功能：

- 展开/收起。
- 搜索定位。
- 查看人员详情。
- 打开“调整直属上级”弹窗。
- 展示未分配人员。

- [ ] **步骤 3：实现层级修改确认**

弹窗流程：

```text
选择人员
→ 选择新直属上级
→ 展示原路径与新路径
→ 点击保存
→ PATCH /api/staff/profiles/:id/manager
→ 刷新组织树
```

若 API 返回 `ORGANIZATION_CYCLE`，在弹窗内显示服务端返回的路径，不关闭弹窗。

- [ ] **步骤 4：迁移旧管理功能入口**

将注册审核、小区、提醒和 SLA 设置移动到对应标签；删除旧管理平台重复 DOM 和重复导航。

- [ ] **步骤 5：实现人员档案编辑**

主管可编辑：

- 入职日期。
- 职位。
- 技能。
- 直属上级。
- 在职状态。

停用人员时显示：“停用档案不会在本轮自动禁用登录账号”。

- [ ] **步骤 6：语法和 DOM 选择器检查**

```bash
node --check public/js/management-workspace.js
rg -n 'page-admin|page-schedule' public/index.html public/app.js public/js
```

预期：旧页面 ID 不再作为导航目标；如果作为兼容容器保留，必须有注释说明并在任务 14 删除。

- [ ] **步骤 7：提交**

```bash
git add public/js/management-workspace.js public/index.html public/styles.css public/app.js
git commit -m "feat: add organization management workspace"
```

### 任务 13：实现响应式日历和考勤管理

**文件：**
- 修改：`public/js/responsive-calendar.js`
- 修改：`public/js/management-workspace.js`
- 修改：`public/js/my-page.js`
- 修改：`public/styles.css`
- 修改：`public/app.js:1410-1630`

- [ ] **步骤 1：编写日历视图选择测试**

在 `test/workforce-utils.test.js`：

```js
assert.equal(selectCalendarView(1200), 'day-grid');
assert.equal(selectCalendarView(767), 'agenda');
```

运行并确认新增断言先失败。

- [ ] **步骤 2：实现桌面日视图**

`ResponsiveCalendar.render(container, data, options)`：

- 左侧时间刻度。
- 人员固定列头。
- 当前时间红线。
- 非值班灰色斜纹。
- 工单圆角卡片。
- 冲突红色卡片并分栏。
- 点击卡片调用 `openDrawer(ticketId)`。

时间定位公式：

```js
const top = ((eventStartMinutes - rangeStartMinutes) / rangeMinutes) * 100;
const height = ((eventEndMinutes - eventStartMinutes) / rangeMinutes) * 100;
```

- [ ] **步骤 3：实现窄屏人员议程**

宽度小于 768px 时：

- 每人一张卡。
- 展示班次、状态、已排工时。
- 工单按时间排序。
- 冲突标红。
- 无事件显示“可派时段”。

- [ ] **步骤 4：实现排班和考勤管理交互**

管理工作台支持：

- 新增单日排班。
- 批量选择人员和日期。
- 工作、休息、请假。
- 冲突确认后带 `overwrite: true` 重试。
- 查看应到、实到、迟到、早退和缺卡。
- 主管修正时强制填写原因。

- [ ] **步骤 5：实现个人打卡**

“我的”页面：

- 签到按钮调用 `/api/attendance/check-in`。
- 签退按钮调用 `/api/attendance/check-out`。
- 重复打卡显示已有时间。
- 无排班显示明确提示。
- 成功后同时刷新今日排班和本月考勤。

- [ ] **步骤 6：删除旧日历实现**

从 `public/app.js` 删除由新模块替代的：

```text
renderSchedule
renderScheduleWithTickets
renderTimelineDay
detectTimeConflicts
countDayConflicts
```

保留通用 `sameDay`、`fmtHM` 时，移动到 `workforce-utils.js`，避免双份实现。

- [ ] **步骤 7：运行测试和语法检查**

```bash
node --test test/workforce-utils.test.js
find public -maxdepth 2 -name '*.js' -print0 | xargs -0 -n1 node --check
```

预期：全部退出 0。

- [ ] **步骤 8：提交**

```bash
git add public/js/responsive-calendar.js public/js/management-workspace.js public/js/my-page.js public/js/workforce-utils.js public/app.js public/styles.css test/workforce-utils.test.js
git commit -m "feat: add responsive schedule and attendance UI"
```

### 任务 14：实现人员报告、旧资料导入和最终回归

**文件：**
- 修改：`public/js/staff-report.js`
- 修改：`public/js/management-workspace.js`
- 修改：`public/js/workforce-api.js`
- 修改：`public/app.js:1315-1390`
- 修改：`routes/profiles.js`
- 修改：`services/workforce-migration.js`
- 创建：`test/local-profile-import.test.js`
- 创建：`scripts/verify-workforce-migration.js`
- 修改：`config.js`
- 修改：`README.md`
- 修改：`介绍.md`

- [ ] **步骤 1：编写旧资料导入失败测试**

输入：

```js
const legacy = [
  { name: '张师傅', phone: '13800112201', skill: '水暖', dutyStart: '08:00', dutyEnd: '18:00', joinDate: '2024-01-02' }
];
```

断言：

- 手机号优先匹配。
- 无手机号时唯一姓名匹配。
- 同名冲突进入 `conflicts`。
- 已导入版本不重复导入。

- [ ] **步骤 2：实现导入预览和确认 API**

```text
POST /api/staff/profiles/import-preview
POST /api/staff/profiles/import-confirm
```

预览只返回差异，不写数据库；确认只写用户勾选的字段。导入版本写入任务 2 创建的 `workforce_import_batches`，`import_key` 使用客户端数据规范化 JSON 的 SHA-256 摘要；同一摘要第二次确认返回已有导入结果，不重复写入。

- [ ] **步骤 3：实现人员报告界面**

筛选：

- 人员。
- 今日、近 7 天、本月。
- 自定义开始和结束日期。
- 当前小区或全部授权小区。

展示：

- 期间接单。
- 期间完成。
- 平均时长。
- SLA 按时率。
- 处理中、搁置和退回。
- 复发和多人反馈。
- 分类分布。
- 考勤汇总。

- [ ] **步骤 4：实现报告导出**

保留复制、打印和 Word 下载。导出内容必须包含：

```text
报告人员
日期范围
小区范围
接单口径说明
完成口径说明
工单指标
考勤指标
生成时间
```

- [ ] **步骤 5：删除旧报告重复实现**

从 `public/app.js` 移除已被 `staff-report.js` 接管的 `showReport()`、`generateReport()`、`copyReport()`、`downloadReportWord()` 和 `printReport()`，或保留一个兼容代理：

```js
function showReport() {
  return window.StaffReport.open();
}
```

不得保留两套报告状态。

- [ ] **步骤 6：运行全部自动化测试**

```bash
npm test
```

预期：0 个失败、0 个取消。

- [ ] **步骤 7：运行全部语法检查**

```bash
find . -maxdepth 3 -name '*.js' -not -path './node_modules/*' -print0 | xargs -0 -n1 node --check
```

预期：退出码 0。

- [ ] **步骤 8：执行数据库迁移冒烟检查**

复制数据库到临时目录后运行初始化，禁止直接用测试修改正式 `data.db`：

```bash
workforce_tmp_dir=$(mktemp -d)
cp data.db "$workforce_tmp_dir/data.db"
DB_PATH="$workforce_tmp_dir/data.db" node scripts/verify-workforce-migration.js
```

`scripts/verify-workforce-migration.js` 必须打印：

```text
users=<原用户数>
profiles=<同等档案数>
tickets=<原工单数>
unmatched_assignees=<数量>
schema=ok
```

若 `config.js` 尚不支持 `DB_PATH` 环境变量，在本步骤修改为：

```js
DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data.db')
```

- [ ] **步骤 9：浏览器回归检查**

启动：

```bash
npm start
```

逐项验证：

```text
主管登录
首页月度统计
我的资料与日/月/年统计
组织树和循环阻止
单日与批量排班
员工签到签退
考勤补卡和修改日志
桌面日视图
窄屏议程视图
人员报告
现有工单派单、驳回、完成
照片上传与预览
提醒和通知入口
```

- [ ] **步骤 10：更新文档**

`README.md` 更新启动、数据模型和主要页面；`介绍.md` 更新已实现状态、API 和原先的人员/考勤边界说明。

- [ ] **步骤 11：提交**

```bash
git add public/js/staff-report.js public/js/management-workspace.js public/js/workforce-api.js public/app.js routes/profiles.js services/workforce-migration.js test/local-profile-import.test.js scripts/verify-workforce-migration.js config.js README.md 介绍.md
git commit -m "feat: complete workforce reporting upgrade"
```

## 最终验收命令

在最后一次完成声明前重新运行：

```bash
npm test
find . -maxdepth 3 -name '*.js' -not -path './node_modules/*' -print0 | xargs -0 -n1 node --check
git diff --check
git status --short
```

预期：

- `npm test` 零失败。
- 所有 JavaScript 文件语法检查通过。
- `git diff --check` 无空白错误。
- `git status --short` 只显示用户已有的无关修改，或实现任务明确产生且尚未提交的文件。

## 规格覆盖映射

| 规格要求 | 实现任务 |
| --- | --- |
| 服务端人员主数据 | 任务 2、3、4 |
| 自定义单线组织树 | 任务 4、12 |
| 主管“我的” | 任务 9、11 |
| 主管个人动作 | 任务 5、9、11 |
| 递归团队成果 | 任务 4、9、11 |
| 每日排班 | 任务 6、13 |
| 实际签到签退 | 任务 7、13 |
| 请假、补卡和审计 | 任务 6、7、13 |
| 桌面日视图 | 任务 8、13 |
| 窄屏议程 | 任务 8、13 |
| 人员时间范围报告 | 任务 9、14 |
| 接单/完成双口径 | 任务 5、9、14 |
| 本月工单总量修正 | 任务 9、11 |
| 本月实际出勤 | 任务 7、9、11 |
| localStorage 兼容导入 | 任务 3、14 |
| 历史工单负责人回填 | 任务 3、5 |
| 错误响应和冲突 | 任务 4、6、7、8 |
| 自动化与回归验证 | 任务 1-14 |
