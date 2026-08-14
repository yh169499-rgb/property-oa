# 班次派单窗口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将班次明确实现为员工可派单窗口，阻止无班次、请假、休息、班次外和工单重叠派单，并统一日历北京时间展示。

**架构：** 新建独立的派单可用性服务，由工单创建和重新派单入口共同调用；日历继续只对工单事件计算重叠。前端通过统一的上海时区格式函数展示班次和工单时间，模拟数据仅调整 `MOCK-E2E-*` 记录。

**技术栈：** Node.js、Express、sql.js/SQLite、浏览器原生 JavaScript、Node test runner。

---

## 文件职责

- 创建 `services/dispatch-availability.js`：班次窗口、休假状态及工单占用冲突的单一服务端校验入口。
- 修改 `routes/tickets.js`：创建处理中工单、修改处理人时调用派单校验并返回稳定 409 错误。
- 修改 `services/calendar.js`：为工单重叠结果补充明确类型和异常信息，保持班次不进入冲突算法。
- 修改 `public/js/workforce-utils.js`：提供固定 `Asia/Shanghai` 的日期和时间格式函数。
- 修改 `public/js/worker-home.js`、`public/js/my-page.js`、`public/js/responsive-calendar.js`：统一北京时间和可派/冲突文案。
- 修改 `services/retained-test-data.js`：普通模拟工单班次内不重叠，保留一组明确的两工单重叠样本。
- 修改 `test/dispatch-availability.test.js`、`test/ticket-scope.test.js`、`test/calendar.test.js`、`test/workforce-utils.test.js`、`test/worker-home.test.js`、`test/my-page.test.js`、`test/retained-test-data.test.js`：覆盖规则和回归。

### 任务 1：派单可用性服务

**文件：**
- 创建：`services/dispatch-availability.js`
- 创建：`test/dispatch-availability.test.js`

- [ ] **步骤 1：编写失败的服务测试**

覆盖白班内成功、无排班、休息、请假、班次外、预计结束超班、跨夜班和同员工未完成工单重叠。期望错误接口：

```js
assert.throws(
  () => assertDispatchAvailable(db, { staffProfileId: 2, assignedAt, estimatedHours: 2 }),
  error => error.status === 409 && error.code === 'ASSIGNMENT_OUTSIDE_SHIFT'
);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/dispatch-availability.test.js`

预期：FAIL，原因是 `services/dispatch-availability.js` 尚不存在。

- [ ] **步骤 3：实现最少服务代码**

导出：

```js
function assertDispatchAvailable(db, {
  staffProfileId,
  assignedAt,
  estimatedHours,
  excludeTicketId = null,
}) {}
```

使用 `Asia/Shanghai` 日期定位 `shift_assignments.work_date`，验证 `assignment_type` 和 `[start_at, end_at)`；查询同一 `assignee_staff_profile_id` 下状态非 `done` 的工单，按 `assigned_at + estimated_hours` 检测重叠。错误对象包含 `status = 409`、稳定 `code`，冲突时包含 `conflictingTicketIds`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/dispatch-availability.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add services/dispatch-availability.js test/dispatch-availability.test.js
git commit -m "feat: validate dispatch against staff shifts"
```

### 任务 2：接入工单创建与派单接口

**文件：**
- 修改：`routes/tickets.js`
- 修改：`test/ticket-scope.test.js`

- [ ] **步骤 1：编写失败的接口测试**

增加以下断言：处理中工单在班次内创建成功；无排班、请假、休息、班次外、超出班次结束和重叠分别返回 HTTP 409；修改 `worker` 也执行相同校验；错误 JSON 包含稳定 `code`，重叠包含 `conflicting_ticket_ids`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/ticket-scope.test.js`

预期：至少一个新增断言失败，因为路由尚未调用班次校验。

- [ ] **步骤 3：接入统一校验**

在成功解析 `resolveAssignee` 后调用：

```js
assertDispatchAvailable(getDB(), {
  staffProfileId: assignee.assigneeStaffProfileId,
  assignedAt: now,
  estimatedHours: Number(t.estimated_hours) || 1,
});
```

PATCH 派单使用当前时刻并传入 `excludeTicketId: before.id`。捕获错误时返回：

```js
res.status(error.status || 409).json({
  error: error.message,
  code: error.code,
  conflicting_ticket_ids: error.conflictingTicketIds || [],
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/ticket-scope.test.js test/dispatch-availability.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add routes/tickets.js test/ticket-scope.test.js
git commit -m "feat: enforce shift windows when assigning tickets"
```

### 任务 3：明确日历冲突语义

**文件：**
- 修改：`services/calendar.js`
- 修改：`test/calendar.test.js`

- [ ] **步骤 1：编写失败的日历测试**

断言班次 `08:00–18:00` 覆盖 `09:00–11:00` 工单时不产生班次冲突；两张同员工工单 `09:00–11:00` 与 `10:00–12:00` 返回 `type: 'ticket_overlap'`；不同员工不冲突。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/calendar.test.js`

预期：新增 `type` 断言失败。

- [ ] **步骤 3：补充冲突类型**

在 `detectCalendarConflicts` 结果中增加：

```js
type: 'ticket_overlap'
```

不把班次添加到 `events`，不更改现有两工单区间算法。

- [ ] **步骤 4：运行测试验证通过并提交**

运行：`node --test --test-concurrency=1 test/calendar.test.js`

```bash
git add services/calendar.js test/calendar.test.js
git commit -m "fix: label calendar conflicts as ticket overlaps"
```

### 任务 4：统一北京时间与页面文案

**文件：**
- 修改：`public/js/workforce-utils.js`
- 修改：`public/js/worker-home.js`
- 修改：`public/js/my-page.js`
- 修改：`public/js/responsive-calendar.js`
- 修改：`test/workforce-utils.test.js`
- 修改：`test/worker-home.test.js`
- 修改：`test/my-page.test.js`
- 修改：`test/management-template-ui.test.js`

- [ ] **步骤 1：编写失败的前端测试**

对 UTC 值 `2026-08-13T01:00:00.000Z` 断言显示 `09:00`；断言班次文案含“该时段内可派单”；冲突文案包含两张工单编号并明确“工单时间重叠”。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/workforce-utils.test.js test/worker-home.test.js test/my-page.test.js test/management-template-ui.test.js`

预期：北京时间或新文案断言失败。

- [ ] **步骤 3：实现上海时区格式函数并替换截取时间**

在 `workforce-utils.js` 导出：

```js
function shanghaiTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}
```

三个页面都调用 `WorkforceUtils.shanghaiTime`，删除 `slice(11, 16)`。冲突提示从 `calendar.conflicts` 读取 `ticketIds`，显示具体编号。

- [ ] **步骤 4：运行测试验证通过并提交**

运行：`node --test --test-concurrency=1 test/workforce-utils.test.js test/worker-home.test.js test/my-page.test.js test/management-template-ui.test.js`

```bash
git add public/js/workforce-utils.js public/js/worker-home.js public/js/my-page.js public/js/responsive-calendar.js test/workforce-utils.test.js test/worker-home.test.js test/my-page.test.js test/management-template-ui.test.js
git commit -m "fix: show dispatch schedules in Shanghai time"
```

### 任务 5：修正模拟数据并验证持久化迁移

**文件：**
- 修改：`services/retained-test-data.js`
- 修改：`test/retained-test-data.test.js`
- 修改：`test/verify-retained-test-data.test.js`

- [ ] **步骤 1：编写失败的模拟数据测试**

断言普通当前工单都处于对应工作班次内且不重叠；张师傅保留两张北京时间为 `09:00–11:00` 和 `10:00–12:00` 的明确冲突样本；重复执行迁移记录数稳定且非 `MOCK-E2E-*` 工单不变。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/retained-test-data.test.js test/verify-retained-test-data.test.js`

预期：普通工单不重叠或北京时间断言失败。

- [ ] **步骤 3：调整模拟时间**

仅修改 `seedMockTickets` 中 `MOCK-E2E-*` 的 `assigned_at` 和 `estimated_hours`：普通样本安排到各自班次内不重叠；冲突样本使用同一天 `09:00–11:00` 与 `10:00–12:00`。保持迁移幂等，不触碰非模拟记录。

- [ ] **步骤 4：运行测试验证通过并提交**

运行：`node --test --test-concurrency=1 test/retained-test-data.test.js test/verify-retained-test-data.test.js`

```bash
git add services/retained-test-data.js test/retained-test-data.test.js test/verify-retained-test-data.test.js
git commit -m "fix: align mock tickets with dispatch shifts"
```

### 任务 6：集成验证、上线和生产数据修正

**文件：**
- 验证：上述全部修改文件

- [ ] **步骤 1：运行定向回归**

运行：

```bash
node --test --test-concurrency=1 \
  test/dispatch-availability.test.js test/ticket-scope.test.js test/calendar.test.js \
  test/workforce-utils.test.js test/worker-home.test.js test/my-page.test.js \
  test/management-template-ui.test.js test/retained-test-data.test.js \
  test/verify-retained-test-data.test.js test/auth-security.test.js
```

预期：全部 PASS，且无未处理异常。

- [ ] **步骤 2：检查差异和工作区范围**

运行：`git diff --check` 与 `git status --short`，确保不提交 `data.db`、备份文件、压缩包和 `.superpowers/`。

- [ ] **步骤 3：发布到 GitHub 并合并生产分支**

创建专用发布分支和 PR，合并到 `master`，等待 Render 健康检查 `/api/health` 返回 200。

- [ ] **步骤 4：安全修正生产模拟数据**

部署一个受主管认证、固定确认串和一次性凭据保护的临时迁移入口；先备份数据库，再只更新 `MOCK-E2E-*` 时间数据；验证后立即删除临时入口并再次部署。

- [ ] **步骤 5：线上验收**

验证张师傅页面显示白班 `08:00–18:00`、工单为北京时间、普通工单在班次内；冲突提示仅由两张工单重叠产生；五个账号、三类工单范围和历史数据仍完整。

