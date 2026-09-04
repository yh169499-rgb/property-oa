# 多企业隔离、提醒与工单详情修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复同名小区串扰、工单红点、可配置预警、关键流转通知、完整时间线与现场照片交互。

**架构：** 服务端继续以认证令牌中的 `tenant_id` 作为所有数据边界，并新增持久化提醒调度与权威活动时间线。前端认证状态改为页签级存储，附件通过认证请求转换为 Blob URL 展示。

**技术栈：** Node.js、Express、sql.js、原生 JavaScript、node:test、Multer、秒回消息接口。

---

## 文件结构

- 创建 `services/ticket-reminders.js`：租户提醒配置、持久状态、启动恢复和按工单状态选择提醒对象。
- 修改 `services/tenant-schema.js`：提醒状态表、同租户小区规范化唯一索引与旧重复记录归并。
- 修改 `services/jzm-messaging.js`：提交、退回、搁置和超时提醒文案与 @ 目标。
- 修改 `services/ticket-activity.js`：服务端时间线标题、历史兼容节点和批量组装。
- 修改 `routes/communities.js`：同租户重复名称校验。
- 修改 `routes/settings.js`、`index-new.js`：提醒设置接入独立调度服务并在启动时恢复。
- 修改 `routes/tickets.js`：创建活动日志、状态提醒、提醒状态重置和时间线返回。
- 修改 `public/app.js`、`public/js/api.js`、`public/js/management-workspace.js`、`public/js/worker-home.js`、`public/js/my-page.js`：页签会话、红点、认证提醒设置和现场材料交互。
- 新增/修改 `test/*.test.js`：覆盖全部修复与回归行为。

### 任务 1：锁定租户隔离和浏览器会话行为

**文件：**
- 修改：`test/tenant-base-isolation.test.js`
- 创建：`test/community-name-isolation.test.js`
- 修改：`test/auth-token-sync.test.js`
- 修改：`services/tenant-schema.js`
- 修改：`routes/communities.js`
- 修改：`public/app.js`
- 修改：`public/js/api.js`
- 修改：`public/js/management-workspace.js`
- 修改：`public/js/worker-home.js`
- 修改：`public/js/my-page.js`

- [ ] **步骤 1：编写失败测试**

```js
test('不同租户允许同名小区，同租户规范化重名返回 409', async () => {
  assert.equal((await createCommunity(tenantA, ' 阳光花园 ')).status, 200);
  assert.equal((await createCommunity(tenantB, '阳光花园')).status, 200);
  assert.equal((await createCommunity(tenantA, '阳光花园')).status, 409);
});

test('业务登录凭据仅写入 sessionStorage', () => {
  assert.match(appSource, /sessionStorage\.setItem\('login_user'/);
  assert.doesNotMatch(appSource, /localStorage\.setItem\('login_user'/);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test test/community-name-isolation.test.js test/auth-token-sync.test.js`
预期：重复小区未返回 409，且源码仍使用 `localStorage`。

- [ ] **步骤 3：实现最小修复**

```js
function normalizedCommunityName(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

const duplicate = queryOne(
  'SELECT id FROM communities WHERE tenant_id = ? AND lower(trim(name)) = lower(trim(?)) AND id <> ?',
  [tenantId, name, currentId || '']
);
if (duplicate) throw httpError(409, 'COMMUNITY_NAME_EXISTS', '当前企业已存在同名小区');
```

将认证 token、用户、角色和当前小区改为 `sessionStorage`；退出时同时清理旧存储。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/community-name-isolation.test.js test/auth-token-sync.test.js test/tenant-base-isolation.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add services/tenant-schema.js routes/communities.js public test
git commit -m "fix: isolate community and browser sessions"
```

### 任务 2：实现持久化自定义预警与关键状态通知

**文件：**
- 创建：`services/ticket-reminders.js`
- 修改：`services/tenant-schema.js`
- 修改：`services/jzm-messaging.js`
- 修改：`routes/settings.js`
- 修改：`routes/tickets.js`
- 修改：`index-new.js`
- 创建：`test/ticket-reminders.test.js`
- 修改：`test/jzm-ticket-alerts.test.js`

- [ ] **步骤 1：编写失败测试**

```js
test('提醒服务重启后恢复配置且同一状态按间隔去重', async () => {
  await runDueReminders({ db, now: fixedNow, send });
  await runDueReminders({ db, now: fixedNow, send });
  assert.equal(send.mock.calls.length, 1);
});

test('提交、退回和搁置均 @主管，完成不 @', async () => {
  assert.equal(targetFor('submitted').kind, 'manager');
  assert.equal(targetFor('returned').kind, 'manager');
  assert.equal(targetFor('suspended').kind, 'manager');
  assert.equal(targetFor('completed').contactId, '');
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test test/ticket-reminders.test.js test/jzm-ticket-alerts.test.js`
预期：提醒服务不存在，新通知类型未实现。

- [ ] **步骤 3：实现提醒服务和通知**

```js
async function runDueReminders({ db, tenantId, now = new Date(), send = sendTicketAlert }) {
  const interval = getReminderInterval(db, tenantId);
  const tickets = listReminderCandidates(db, tenantId);
  for (const ticket of tickets) {
    if (isDue(db, ticket, interval, now)) {
      await send({ db, tenantId, kind: 'overdue', ticket });
      markSent(db, ticket, now);
    }
  }
}
```

工单状态变化后调用 `resetTicketReminderState`；`submit`、`return`、`suspend` 分别发送主管即时提醒；服务启动调用 `restoreReminderSchedulers()`。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/ticket-reminders.test.js test/jzm-ticket-alerts.test.js test/ticket-activity.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add services routes index-new.js test
git commit -m "feat: persist ticket reminders and workflow alerts"
```

### 任务 3：返回服务端权威流转时间线

**文件：**
- 修改：`services/ticket-activity.js`
- 修改：`routes/tickets.js`
- 修改：`test/ticket-activity.test.js`
- 修改：`test/ticket-scope.test.js`

- [ ] **步骤 1：编写失败测试**

```js
test('工单详情按时间返回创建到完结的活动节点', async () => {
  const ticket = await getTicket(id);
  assert.deepEqual(ticket.steps.map(step => step.action), [
    'create', 'assign', 'accept', 'submit', 'approve_complete'
  ]);
});

test('没有活动日志的历史工单至少生成创建、派单和完结节点', () => {
  assert.deepEqual(buildTimeline(db, historical).map(x => x.action), [
    'create', 'assign', 'approve_complete'
  ]);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test test/ticket-activity.test.js test/ticket-scope.test.js`
预期：接口仍只返回 `metadata.steps`，新建工单没有 create 日志。

- [ ] **步骤 3：实现时间线**

```js
function buildTicketTimeline(db, ticket) {
  const activities = listTicketActivities(db, ticket.tenant_id, ticket.id);
  return mergeHistoricalFallbacks(ticket, activities).map(toTimelineStep);
}
```

创建工单时在同一事务记录 `create`；列表和详情返回由服务端组装的 `steps`。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/ticket-activity.test.js test/ticket-scope.test.js test/tenant-ticket-isolation.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add services/ticket-activity.js routes/tickets.js test
git commit -m "feat: return authoritative ticket timelines"
```

### 任务 4：修复红点、提醒配置请求和现场材料交互

**文件：**
- 修改：`public/app.js`
- 创建：`test/ticket-ui-regressions.test.js`

- [ ] **步骤 1：编写失败测试**

```js
test('导航红点统计所有未完成且当前账号可见的工单', () => {
  assert.equal(countOpen([{ type: 'repair', status: 'doing' }]).repair, 1);
});

test('提醒设置请求带认证头，现场图片通过认证 Blob 加载', () => {
  assert.match(source, /settings\/reminder[\s\S]*authHeaders/);
  assert.match(source, /fetch\(p\.url,\{headers:authHeaders\(\)\}\)/);
  assert.match(source, /capture=['"]environment['"]/);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test test/ticket-ui-regressions.test.js`
预期：红点忽略处理中工单、提醒请求无认证、图片直接使用受保护 URL。

- [ ] **步骤 3：实现前端修复**

```js
if (t.status === 'done' || counts[t.type] === undefined) return;

const response = await fetch(p.url, { headers: authHeaders() });
const objectUrl = URL.createObjectURL(await response.blob());
```

操作区分别渲染“拍照”和“上传照片”，拍照 input 使用 `capture="environment"`，所有提醒 GET/POST 使用 `authHeaders(true)`。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/ticket-ui-regressions.test.js test/auth-token-sync.test.js`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add public/app.js test/ticket-ui-regressions.test.js
git commit -m "fix: restore ticket badges and authenticated photos"
```

### 任务 5：全量验证

**文件：**
- 修改：`docs/superpowers/plans/2026-09-04-tenant-alert-workflow-fixes.md`

- [ ] **步骤 1：运行静态检查**

运行：`git diff --check`
预期：无输出，退出码 0。

- [ ] **步骤 2：运行完整测试**

运行：`npm test`
预期：全部测试 PASS，失败数为 0。

- [ ] **步骤 3：本地浏览器烟测**

验证两个页签登录不同企业、同名小区隔离、三类红点、提醒间隔保存、时间线、拍照/上传和图片点击预览。

- [ ] **步骤 4：检查变更范围**

运行：`git status --short && git diff --stat origin/master...HEAD`
预期：仅包含本设计涉及的服务端、前端、测试和文档文件。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/plans/2026-09-04-tenant-alert-workflow-fixes.md
git commit -m "docs: record tenant alert workflow verification"
```
