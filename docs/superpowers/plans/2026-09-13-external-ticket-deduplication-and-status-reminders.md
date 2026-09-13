# 外部反馈去重建单与状态超时提醒实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让外部反馈在地址完整后原子地新建或合并工单，并让主管分别配置待派单、搁置、待确认的超时提醒，处理中永不提醒。

**架构：** 新增独立的外部反馈受理服务，在同步数据库事务内完成位置校验、重复匹配、编号生成、建单/合并和受理审计；路由提交后才发送创建预警。提醒服务改为读取企业级状态映射，仅扫描 `wait`、`pending`、`confirm`，状态变化继续复用已有提醒状态清理机制。

**技术栈：** Node.js 24、Express 4、sql.js/SQLite、原生 `node:test`、浏览器原生 JavaScript。

---

## 文件结构

- 创建 `services/external-ticket-intake.js`：位置完整性、事件键、重复/复发匹配和原子受理决策。
- 修改 `services/tenant-schema.js`：新增租户隔离的 `ticket_ingest_events` 表和索引。
- 修改 `routes/tickets.js`：外部请求调用受理服务；仅 `created` 发送预警；内部建单保持原流程。
- 修改 `services/ticket-source-audit.js`：把 `message` 作为原文标准字段，保留旧字段回退。
- 创建 `test/external-ticket-intake.test.js`：覆盖延期、合并、不同地址、复发、租户隔离和事务回滚。
- 修改 `test/jzm-ticket-alerts.test.js`：覆盖外部受理的 HTTP 响应、预警次数和首位反馈人冻结。
- 修改 `test/ticket-source-audit.test.js`：覆盖每次反馈来源和受理决策追溯。
- 修改 `services/ticket-reminders.js`：状态级配置、严格校验、移除处理中扫描、重复提醒和重启恢复。
- 修改 `routes/settings.js`：提醒设置 API 改为读写 `intervals` 映射。
- 修改 `public/js/management-workspace.js`：设置页展示三个状态的分钟输入。
- 修改 `public/app.js`：加载、保存三个提醒时长并显示稳定错误。
- 修改 `test/reminder-persistence.test.js`：覆盖状态级计时、处理中不提醒、状态重置和恢复。
- 修改 `test/management-workspace-static.test.js`：覆盖三个设置输入和认证请求。
- 修改 `docs/API.md`：说明受理成功不等于建单成功、位置完整字段和状态提醒接口。

### 任务 1：建立外部反馈受理审计表

**文件：**
- 修改：`services/tenant-schema.js:1-25,343-401`
- 修改：`test/workforce-schema.test.js`
- 创建：`test/external-ticket-intake.test.js`

- [ ] **步骤 1：编写失败的表结构测试**

在 `test/external-ticket-intake.test.js` 创建完整测试库并断言：

```js
test('外部受理审计允许延期记录没有工单号且按企业索引', async () => {
  const db = await createFullTestDB();
  const columns = db.exec('PRAGMA table_info(ticket_ingest_events)')[0].values;
  const byName = Object.fromEntries(columns.map((row) => [row[1], row]));
  assert.ok(byName.tenant_id);
  assert.equal(byName.ticket_id[3], 0);
  assert.ok(byName.decision);
  assert.ok(byName.repeat_key);
  assert.ok(byName.request_json);
});
```

- [ ] **步骤 2：运行测试并确认表尚不存在**

运行：

```bash
node --test --test-concurrency=1 test/external-ticket-intake.test.js
```

预期：FAIL，错误包含 `no such table: ticket_ingest_events` 或 `PRAGMA` 无结果。

- [ ] **步骤 3：新增租户表、约束和索引**

在 `services/tenant-schema.js` 的 `TENANT_TABLES` 加入 `ticket_ingest_events`，并在 `ticket_source_audits` 附近创建：

```js
db.run(`CREATE TABLE IF NOT EXISTS ticket_ingest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  community_id TEXT NOT NULL DEFAULT '',
  ticket_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('deferred','merged','created')),
  normalized_location TEXT NOT NULL DEFAULT '',
  repeat_key TEXT NOT NULL DEFAULT '',
  feedback_person TEXT NOT NULL DEFAULT '',
  feedback_group TEXT NOT NULL DEFAULT '',
  original_message TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ticket_ingest_tenant_created
  ON ticket_ingest_events(tenant_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ticket_ingest_ticket
  ON ticket_ingest_events(tenant_id, ticket_id)`);
```

- [ ] **步骤 4：运行结构测试**

运行：

```bash
node --test --test-concurrency=1 test/external-ticket-intake.test.js test/workforce-schema.test.js
```

预期：PASS。

- [ ] **步骤 5：提交表结构**

```bash
git add services/tenant-schema.js test/external-ticket-intake.test.js test/workforce-schema.test.js
git commit -m "feat: add external ticket intake audit schema"
```

### 任务 2：实现位置判定和原子受理决策

**文件：**
- 创建：`services/external-ticket-intake.js`
- 修改：`test/external-ticket-intake.test.js`

- [ ] **步骤 1：编写位置完整性和事件键失败测试**

加入以下断言：

```js
test('显式位置完整性优先且空地址和占位地址延期', () => {
  assert.equal(resolveLocationCompleteness({ loc: '3号楼502', location_complete: false }), false);
  assert.equal(resolveLocationCompleteness({ loc: '3号楼502', locationComplete: true }), true);
  assert.equal(resolveLocationCompleteness({ loc: '待确认' }), false);
  assert.equal(resolveLocationCompleteness({ loc: '3号楼 502' }), true);
  assert.throws(
    () => resolveLocationCompleteness({ loc: '3号楼502', location_complete: 'maybe' }),
    (error) => error.code === 'INVALID_LOCATION_COMPLETE'
  );
});

test('规范化位置不混淆不同房号', () => {
  assert.equal(normalizeLocation('３号楼 ５０２'), normalizeLocation('3号楼502'));
  assert.notEqual(normalizeLocation('3号楼502'), normalizeLocation('3号楼503'));
});
```

- [ ] **步骤 2：运行测试确认导出函数不存在**

运行：

```bash
node --test --test-concurrency=1 test/external-ticket-intake.test.js
```

预期：FAIL，错误包含 `Cannot find module '../services/external-ticket-intake'`。

- [ ] **步骤 3：实现纯函数和稳定错误**

在新服务中实现并导出：

```js
const PLACEHOLDER_LOCATIONS = new Set(['', '未知', '待确认', '未提供', '暂不清楚']);

function normalizeLocation(value) {
  return String(value || '').normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[—–-]/g, '-')
    .toLowerCase();
}

function parseExplicitBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  const error = new Error('位置完整性格式不合法');
  error.status = 400;
  error.code = 'INVALID_LOCATION_COMPLETE';
  throw error;
}

function resolveLocationCompleteness(input = {}) {
  if (PLACEHOLDER_LOCATIONS.has(normalizeLocation(input.loc))) return false;
  if (Object.hasOwn(input, 'location_complete')) return parseExplicitBoolean(input.location_complete);
  if (Object.hasOwn(input, 'locationComplete')) return parseExplicitBoolean(input.locationComplete);
  return true;
}
```

- [ ] **步骤 4：编写原子受理的失败测试**

用同一企业和小区构造 A、B、D、502、503 场景，断言服务返回：

```js
assert.deepEqual(deferred, { decision: 'deferred', ticketId: null, shouldAlert: false });
assert.equal(first.decision, 'created');
assert.equal(second.decision, 'merged');
assert.equal(second.ticketId, first.ticketId);
assert.equal(otherLocation.decision, 'created');
assert.notEqual(otherLocation.ticketId, first.ticketId);
```

再断言同一重复事件最终只有一张未完结工单、`feedback_count = 2`，并且 A 的主反馈人和原文未被 B 覆盖。

- [ ] **步骤 5：实现同步事务内的三态决策**

实现 `acceptExternalFeedback({ db, tenantId, supervisor, community, input, now })`。同一文件同时定义 `findRecentOpenMatch`、`nextTicketId`、`insertExternalTicket`、`recordTicketSourceForInput` 和 `recordIngestEvent`；这些辅助函数只接收显式的 `db`、租户与小区上下文，不读取客户端租户字段：

```js
db.run('BEGIN IMMEDIATE');
try {
  if (!resolveLocationCompleteness(input)) {
    recordIngestEvent(db, { decision: 'deferred', ticketId: null, ...context });
    db.run('COMMIT');
    return { decision: 'deferred', ticketId: null, shouldAlert: false };
  }
  const match = findRecentOpenMatch(db, context);
  if (match) {
    db.run(`UPDATE tickets SET feedback_count = feedback_count + 1, repeat_key = ?
      WHERE tenant_id = ? AND id = ?`, [context.repeatKey, tenantId, match.id]);
    recordTicketSourceForInput(db, match.id, input, 'external_merge');
    recordIngestEvent(db, { decision: 'merged', ticketId: match.id, ...context });
    db.run('COMMIT');
    return { decision: 'merged', ticketId: match.id, shouldAlert: false };
  }
  const ticketId = nextTicketId(db);
  insertExternalTicket(db, { ticketId, ...context });
  recordTicketSourceForInput(db, ticketId, input, 'external');
  recordIngestEvent(db, { decision: 'created', ticketId, ...context });
  db.run('COMMIT');
  return { decision: 'created', ticketId, shouldAlert: true };
} catch (error) {
  try { db.run('ROLLBACK'); } catch (_) {}
  throw error;
}
```

全部 SQL 必须带 `tenant_id` 和 `community_id`。事务中不得 `await`；消息发送和远程持久化放到提交之后。

- [ ] **步骤 6：补充复发、跨租户和回滚测试**

覆盖：30 天内已完成匹配会新建复发工单；同名小区在不同企业互不合并；来源插入失败后工单和审计均不落库。

- [ ] **步骤 7：运行服务测试**

运行：

```bash
node --test --test-concurrency=1 test/external-ticket-intake.test.js
```

预期：PASS。

- [ ] **步骤 8：提交受理服务**

```bash
git add services/external-ticket-intake.js test/external-ticket-intake.test.js
git commit -m "feat: atomically deduplicate external ticket intake"
```

### 任务 3：接入外部 HTTP 路由并冻结首位反馈来源

**文件：**
- 修改：`routes/tickets.js:89-100,304-325,382-560`
- 修改：`services/ticket-source-audit.js:14-37`
- 修改：`test/jzm-ticket-alerts.test.js`
- 修改：`test/ticket-source-audit.test.js`

- [ ] **步骤 1：编写 HTTP 行为失败测试**

在 `test/jzm-ticket-alerts.test.js` 覆盖：

```js
const incomplete = await postExternal({ loc: '', location_complete: false, feedback_person: 'A' });
assert.deepEqual(incomplete.body, { success: true });
assert.equal(ticketCount(db), 0);
assert.equal(sent.length, 0);

await postExternal({ loc: '3号楼502', feedback_person: 'A', message: '502着火' });
await postExternal({ loc: '3号楼502', feedback_person: 'B', message: '502也着火' });
assert.equal(ticketCount(db), 1);
assert.equal(sent.length, 1);
assert.match(sent[0].body.payload.text, /反馈人：A/);
assert.match(sent[0].body.payload.text, /原文消息：502着火/);
```

- [ ] **步骤 2：运行路由测试确认旧逻辑失败**

运行：

```bash
node --test --test-concurrency=1 test/jzm-ticket-alerts.test.js test/ticket-source-audit.test.js
```

预期：FAIL；旧逻辑会为空地址建单，或第二次合并覆盖主反馈来源。

- [ ] **步骤 3：拆分外部与内部创建路径**

把路由改为：

```js
router.post('/external', requireIntegrationToken, createExternalTicket);
router.post('/', requireAuth, createTicket);
```

`createExternalTicket` 完成企业预警配置保存和小区解析后调用 `acceptExternalFeedback`。无论决策是 `deferred`、`merged` 还是 `created`，成功响应都只返回 `res.json({ success: true })`。仅当 `shouldAlert` 为真时，从数据库读取新工单并调用 `notifyTicketAlert({ kind: 'created' })`。

- [ ] **步骤 4：修正原文字段优先级**

在 `routes/tickets.js` 的 `notificationMetadata` 中使用：

```js
originalMessage: input.message || input.original_message || input.originalMessage
  || source.message || source.originalMessage || source.original_message || ''
```

在 `services/ticket-source-audit.js` 的 `normalizeSourceFields` 中把原文提取改为：

```js
originalMessage: String(pick('message', 'original_message', 'originalMessage')).trim(),
```

合并分支不得再把 B 的 `feedbackPerson`、`feedbackGroup`、`originalMessage` 写回工单 `metadata`；B 只写 `ticket_source_audits` 与 `ticket_ingest_events`。

- [ ] **步骤 5：运行外部接口和来源测试**

运行：

```bash
node --test --test-concurrency=1 test/external-ticket-intake.test.js test/jzm-ticket-alerts.test.js test/ticket-source-audit.test.js
```

预期：PASS。

- [ ] **步骤 6：提交路由接入**

```bash
git add routes/tickets.js services/ticket-source-audit.js test/jzm-ticket-alerts.test.js test/ticket-source-audit.test.js
git commit -m "feat: accept incomplete feedback without duplicate alerts"
```

### 任务 4：把统一提醒时长升级为按状态设置

**文件：**
- 修改：`services/ticket-reminders.js:3-160`
- 修改：`routes/settings.js:192-207`
- 修改：`test/reminder-persistence.test.js`

- [ ] **步骤 1：编写状态配置失败测试**

把测试期望改为状态映射：

```js
assert.deepEqual(setReminderIntervals(db, 'tenant-a', {
  wait: 5, pending: 15, confirm: 30,
}), { wait: 5, pending: 15, confirm: 30 });
assert.deepEqual(getReminderIntervals(db, 'tenant-a'), {
  wait: 5, pending: 15, confirm: 30,
});
assert.throws(
  () => setReminderIntervals(db, 'tenant-a', { wait: 1.5, pending: 0, confirm: 0 }),
  (error) => error.code === 'INVALID_REMINDER_INTERVALS'
);
```

- [ ] **步骤 2：编写处理中不提醒和各状态独立计时测试**

建立 `wait`、`doing`、`pending`、`confirm` 四张工单并配置不同阈值。在 16 分钟时断言只发送到期的 `wait` 和 `pending`，发送目标均为主管，`doing` 永远不在发送列表。

- [ ] **步骤 3：运行测试确认旧统一配置失败**

运行：

```bash
node --test --test-concurrency=1 test/reminder-persistence.test.js
```

预期：FAIL，旧服务只支持 `intervalMinutes` 且扫描 `doing`。

- [ ] **步骤 4：实现严格状态映射和旧配置兼容读取**

在 `services/ticket-reminders.js` 定义：

```js
const REMINDER_STATUSES = ['wait', 'pending', 'confirm'];
const REMINDER_SETTING_KEY = 'ticket_reminder_intervals_v2';

function validateInterval(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1440) {
    const error = new Error('提醒时长必须是 0—1440 的整数分钟');
    error.status = 400;
    error.code = 'INVALID_REMINDER_INTERVALS';
    throw error;
  }
  return number;
}
```

`getReminderIntervals` 优先读取新 JSON 设置；新设置不存在时，把旧 `reminder_interval_minutes` 的值迁移解释为 `wait`、`pending`、`confirm` 三项相同值，但不再用于 `doing`。`setReminderIntervals` 一次校验完整对象并以单个 JSON 值原子保存。

- [ ] **步骤 5：修改扫描和调度恢复**

扫描 SQL 固定为：

```sql
SELECT * FROM tickets
WHERE tenant_id = ? AND status IN ('wait','pending','confirm')
```

每张工单使用 `intervals[ticket.status]`。调度周期使用最小正数状态阈值并最大每 60 秒检查一次；三个值全为 0 时停止租户调度器。恢复查询同时识别 `ticket_reminder_intervals_v2` 和旧键，并对 tenant ID 去重。

- [ ] **步骤 6：修改设置 API**

接口形状固定为：

```js
// GET /api/settings/reminder
res.json({ intervals: getReminderIntervals(db, tenantId) });

// POST /api/settings/reminder
const intervals = setReminderIntervals(db, tenantId, req.body.intervals);
res.json({ success: true, intervals, message: '提醒设置已保存' });
```

继续使用 `requireAuth`、`requireAdmin` 和服务端租户 ID。

- [ ] **步骤 7：测试 API、状态重置、重复发送和重启恢复**

断言同一状态每隔配置时长重复提醒；状态从 `pending` 变为 `wait` 后旧提醒记录被删除并从状态活动时间重新计时；服务恢复后未到期不提前发送。

- [ ] **步骤 8：运行提醒相关测试**

运行：

```bash
node --test --test-concurrency=1 test/reminder-persistence.test.js test/tenant-workforce-isolation.test.js test/ticket-activity.test.js
```

预期：PASS。

- [ ] **步骤 9：提交提醒服务**

```bash
git add services/ticket-reminders.js routes/settings.js test/reminder-persistence.test.js
git commit -m "feat: configure ticket reminders by workflow status"
```

### 任务 5：更新主管设置页面

**文件：**
- 修改：`public/js/management-workspace.js:816-867`
- 修改：`public/app.js:1205-1229`
- 修改：`test/management-workspace-static.test.js`

- [ ] **步骤 1：编写三个输入框的失败测试**

在静态测试中断言设置页包含稳定 ID：

```js
assert.match(workspace, /reminder-wait-interval/);
assert.match(workspace, /reminder-pending-interval/);
assert.match(workspace, /reminder-confirm-interval/);
assert.doesNotMatch(workspace, /reminder-doing-interval/);
assert.match(app, /intervals:\s*\{\s*wait:/);
```

- [ ] **步骤 2：运行测试确认旧页面失败**

运行：

```bash
node --test --test-concurrency=1 test/management-workspace-static.test.js
```

预期：FAIL，旧页面只有 `reminder-interval`。

- [ ] **步骤 3：渲染按状态输入**

在提醒卡片中渲染三行：

```js
[
  ['待派单', 'wait'],
  ['搁置', 'pending'],
  ['待确认', 'confirm'],
].forEach(function (item) {
  var input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = '1440';
  input.step = '1';
  input.id = 'reminder-' + item[1] + '-interval';
  reminder.appendChild(field(item[0] + '（分钟）', input));
});
reminder.appendChild(node('p', 'management-hint', '0 为关闭；处理中不发送超时提醒。'));
```

- [ ] **步骤 4：更新加载和保存请求**

`saveReminderInterval` 发送：

```js
body: JSON.stringify({
  intervals: {
    wait: Number($('#reminder-wait-interval').value),
    pending: Number($('#reminder-pending-interval').value),
    confirm: Number($('#reminder-confirm-interval').value),
  }
})
```

`loadReminderInterval` 从 `data.intervals` 分别回填。HTTP 非 2xx 时显示服务端安全错误消息，不显示成功勾选。

- [ ] **步骤 5：运行前端静态测试**

运行：

```bash
node --test --test-concurrency=1 test/management-workspace-static.test.js test/frontend-feature.test.js
```

预期：PASS。

- [ ] **步骤 6：提交设置页面**

```bash
git add public/js/management-workspace.js public/app.js test/management-workspace-static.test.js
git commit -m "feat: expose status reminder settings to supervisors"
```

### 任务 6：更新 API 文档并完成回归验证

**文件：**
- 修改：`docs/API.md`
- 修改：`README.md`（仅在 README 已引用旧提醒请求结构时）

- [ ] **步骤 1：更新外部反馈接口文档**

写明：

- `message` 是原文消息标准字段；
- `location_complete` / `locationComplete` 是可选布尔字段；
- `{"success":true}` 表示反馈已受理，可能是延期、合并或新建；
- 地址不完整不建单、不预警；
- 15 分钟内同企业、同小区、同事件、同位置的未完结工单会合并；
- 错误响应继续使用 `ENTERPRISE_REQUIRED`、`ENTERPRISE_NOT_FOUND`、`INVALID_TICKET_TYPE`、`COMMUNITY_INVALID`、`INVALID_LOCATION_COMPLETE` 等稳定错误码。

- [ ] **步骤 2：更新提醒接口文档**

记录请求与响应示例：

```json
{
  "intervals": {
    "wait": 5,
    "pending": 15,
    "confirm": 30
  }
}
```

说明 0 为关闭、处理中不提醒、状态不变时按间隔重复提醒。

- [ ] **步骤 3：运行格式和目标测试**

运行：

```bash
git diff --check
node --test --test-concurrency=1 test/external-ticket-intake.test.js test/jzm-ticket-alerts.test.js test/ticket-source-audit.test.js test/reminder-persistence.test.js test/management-workspace-static.test.js
```

预期：全部 PASS，`git diff --check` 无输出。

- [ ] **步骤 4：运行完整测试集**

运行：

```bash
npm test
```

预期：全部测试通过，失败数为 0。

- [ ] **步骤 5：提交文档**

```bash
git add docs/API.md README.md
git commit -m "docs: document external intake and status reminders"
```

- [ ] **步骤 6：核对提交与工作区**

运行：

```bash
git status --short
git log --oneline --decorate -8
```

预期：工作区无未提交文件；日志包含本计划的五个功能提交和此前的设计、计划提交。
