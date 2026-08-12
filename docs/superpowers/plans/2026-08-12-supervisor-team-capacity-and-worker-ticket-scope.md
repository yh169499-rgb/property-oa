# 主管四人团队、离职留痕与维修师傅工单范围实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将系统规范为一名主管管理三名维修师傅和一名管家，人员离职时删除登录账号但保留可追溯历史，并让维修师傅安全处理自己名下的报修、投诉和帮助工单。

**架构：** `users` 仅保存可登录身份，`staff_profiles` 保存稳定人员身份；工单和活动使用人员档案 ID 维持离职后的历史关联。团队容量由一个服务统一校验，所有新增、审批、调岗和恢复入口复用。普通员工工单权限由服务端以 `assignee_user_id` 强制限定，前端只展示服务端允许的数据。

**技术栈：** Node.js、Express、sql.js/SQLite、bcryptjs、JWT、原生 JavaScript 前端、Node test runner。

---

## 文件结构

- 创建 `services/team-capacity.js`：规范岗位、统计主管直属在职团队、执行 4/3/1 容量校验。
- 创建 `services/staff-lifecycle.js`：新增员工、审批注册、人员离职的事务服务。
- 创建 `services/ticket-access.js`：工单集合、详情、附件与更新的账号级权限判断及状态字段白名单。
- 修改 `services/workforce.js`：增加离职字段、工单稳定档案引用和必要索引的幂等迁移。
- 修改 `services/organization.js`：调整直属上级时复用容量服务。
- 修改 `services/ticket-activity.js`：派单解析同时返回用户 ID 和人员档案 ID。
- 修改 `services/account-lifecycle.js`：移除旧的“仅停用”实现，兼容调用统一离职服务。
- 修改 `routes/auth.js`：注册审批、主管新增和账号离职使用统一事务服务。
- 修改 `routes/profiles.js`：新建、调岗、恢复与导入统一执行团队容量校验。
- 修改 `routes/tickets.js`：所有读取和操作按用户 ID 授权，三类工单使用一致状态流。
- 修改 `services/calendar.js`：普通员工日历只读取本人稳定归属工单；当前视图排除离职人员。
- 修改 `services/reporting.js`：历史工单按档案显示离职标签，当前团队报告排除离职人员。
- 修改 `routes/directory.js`：通讯录只返回当前在职团队成员。
- 修改 `public/app.js`：维修师傅显示投诉和帮助入口，移除姓名授权判断并开放三类个人操作。
- 修改 `public/js/management-workspace.js`：展示容量占用、满员原因和离职标记。
- 修改 `services/retained-test-data.js`：五个账号、四名在职、两名离职历史人员及三类工单样本。
- 修改 `scripts/verify-retained-test-data.js`：验证 5 个登录账号、4/3/1 团队、2 个离职档案和个人工单隔离。
- 修改 `docs/API.md`、`docs/SECURITY-AUDIT.md`、`README.md`、`介绍.md`：同步最终 API、数据模型、迁移和运维流程。
- 新建/修改对应 `test/*.test.js`：按任务逐步补齐失败测试。

### 任务 1：扩展稳定人员身份和历史工单模式

**文件：**
- 修改：`services/workforce.js`
- 测试：`test/workforce-schema.test.js`

- [ ] **步骤 1：编写失败的模式迁移测试**

在 `test/workforce-schema.test.js` 增加断言：

```js
test('workforce schema keeps departed identity and stable ticket assignee', () => {
  ensureWorkforceSchema(db);
  const profileColumns = columnNames(db, 'staff_profiles');
  assert.ok(profileColumns.includes('departed_at'));
  assert.ok(profileColumns.includes('departed_by_user_id'));
  assert.ok(columnNames(db, 'tickets').includes('assignee_staff_profile_id'));
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/workforce-schema.test.js`

预期：FAIL，缺少 `departed_at`、`departed_by_user_id` 或 `assignee_staff_profile_id`。

- [ ] **步骤 3：实现幂等模式升级**

在 `ensureWorkforceSchema(db)` 中增加：

```js
addColumnIfMissing(db, 'staff_profiles', 'departed_at', "TEXT DEFAULT ''");
addColumnIfMissing(db, 'staff_profiles', 'departed_by_user_id', 'INTEGER');
addColumnIfMissing(db, 'tickets', 'assignee_staff_profile_id', 'INTEGER');
db.run('CREATE INDEX IF NOT EXISTS idx_tickets_assignee_profile ON tickets (assignee_staff_profile_id, created)');
db.run(`UPDATE tickets SET assignee_staff_profile_id = (
  SELECT sp.id FROM staff_profiles sp WHERE sp.user_id = tickets.assignee_user_id
) WHERE assignee_staff_profile_id IS NULL AND assignee_user_id IS NOT NULL`);
```

迁移不得根据姓名猜测档案关联。

- [ ] **步骤 4：运行模式测试**

运行：`node --test test/workforce-schema.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/workforce.js test/workforce-schema.test.js
git commit -m "feat: add stable departed staff identity"
```

### 任务 2：实现统一团队容量服务

**文件：**
- 创建：`services/team-capacity.js`
- 测试：`test/team-capacity.test.js`

- [ ] **步骤 1：编写总容量和岗位容量失败测试**

测试覆盖三个维修师傅和一个管家允许、第四个维修师傅与第二个管家拒绝：

```js
assert.deepEqual(teamUsage(db, supervisorId), {
  total: 4, totalLimit: 4,
  worker: 3, workerLimit: 3,
  keeper: 1, keeperLimit: 1,
});
assert.throws(() => assertTeamCapacity(db, supervisorId, 'worker'), error =>
  error.status === 409 && error.code === 'ROLE_CAPACITY_FULL');
assert.throws(() => assertTeamCapacity(db, supervisorId, 'keeper'), error =>
  error.status === 409 && ['TEAM_CAPACITY_FULL', 'ROLE_CAPACITY_FULL'].includes(error.code));
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/team-capacity.test.js`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现岗位规范、统计和校验**

导出以下稳定接口：

```js
const TEAM_LIMITS = Object.freeze({ total: 4, worker: 3, keeper: 1 });
function normalizedStaffRole(roleOrPosition) { /* worker 或 keeper */ }
function teamUsage(db, managerProfileId, options = {}) { /* 只统计直属 active */ }
function assertTeamCapacity(db, managerProfileId, role, options = {}) { /* 返回 usage 或抛 409 */ }
function findSoleSupervisorProfile(db) { /* 恰好一名 active 主管 */ }
```

`options.excludeProfileId` 用于现有人员调岗时排除本人，避免把不增加容量的更新误判为满员。

- [ ] **步骤 4：运行容量测试**

运行：`node --test test/team-capacity.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/team-capacity.js test/team-capacity.test.js
git commit -m "feat: enforce supervisor team capacity"
```

### 任务 3：实现新增员工与注册审批事务

**文件：**
- 创建：`services/staff-lifecycle.js`
- 修改：`routes/auth.js`
- 测试：`test/auth-security.test.js`
- 测试：`test/staff-lifecycle.test.js`

- [ ] **步骤 1：编写失败的审批和新增测试**

测试必须断言：

```js
assert.equal(fullApproval.response.status, 409);
assert.equal(fullApproval.body.code, 'TEAM_CAPACITY_FULL');
assert.equal(pendingStatus(db, registrationId), 'pending');

const created = approvePendingRegistration(db, registrationId, supervisorUser);
assert.equal(created.user.role, 'worker');
assert.equal(created.profile.manager_id, supervisorProfileId);
assert.equal(created.profile.employment_status, 'active');
```

增加第二个并发式顺序审批用例：第一次审批占满最后名额，第二次在新事务中返回 409，不产生第五个 active 档案。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/staff-lifecycle.test.js test/auth-security.test.js`

预期：FAIL，审批尚未创建人员档案或未检查容量。

- [ ] **步骤 3：实现统一创建服务**

`services/staff-lifecycle.js` 导出：

```js
async function createStaffAccount(db, input, actorUser) {
  // BEGIN -> find supervisor -> assert capacity -> insert users
  // -> insert a new staff_profiles row -> membership -> COMMIT
}
async function approvePendingRegistration(db, registrationId, actorUser) {
  // pending row stays pending on any capacity failure
}
```

路由返回稳定错误结构：

```js
res.status(error.status || 500).json({
  error: error.message,
  code: error.code || 'STAFF_CREATE_FAILED',
  details: error.details || {},
});
```

- [ ] **步骤 4：运行审批测试**

运行：`node --test test/staff-lifecycle.test.js test/auth-security.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/staff-lifecycle.js routes/auth.js test/staff-lifecycle.test.js test/auth-security.test.js
git commit -m "feat: create staff within supervisor capacity"
```

### 任务 4：在组织档案所有入口实施容量约束

**文件：**
- 修改：`services/organization.js`
- 修改：`routes/profiles.js`
- 测试：`test/organization.test.js`
- 测试：`test/profiles-api.test.js`
- 测试：`test/local-profile-import.test.js`

- [ ] **步骤 1：编写绕过路径失败测试**

分别测试 `POST /staff/profiles`、`PATCH /staff/profiles/:id`、`PATCH /staff/profiles/:id/manager` 和导入确认：

```js
assert.equal(response.status, 409);
assert.equal(body.code, 'TEAM_CAPACITY_FULL');
assert.equal(activeDirectReports(db, supervisorProfileId), 4);
```

增加从 `departed` 恢复为 `active` 以及维修师傅改为管家的岗位槽位测试。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/organization.test.js test/profiles-api.test.js test/local-profile-import.test.js`

预期：FAIL，现有入口能够绕过容量限制。

- [ ] **步骤 3：在事务内调用容量服务**

`updateManager` 增加上下文参数：

```js
function updateManager(db, staffId, managerId, options = {}) {
  const target = profileById(db, staffId);
  if (managerId != null && target.employment_status === 'active') {
    assertTeamCapacity(db, managerId, target.position, { excludeProfileId: staffId });
  }
  // 原循环检测和 UPDATE
}
```

档案新增、岗位变更、恢复在职和导入批次在同一事务中逐条验证；任何一条超限，整个批次回滚。

- [ ] **步骤 4：运行组织和导入测试**

运行：`node --test test/organization.test.js test/profiles-api.test.js test/local-profile-import.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/organization.js routes/profiles.js test/organization.test.js test/profiles-api.test.js test/local-profile-import.test.js
git commit -m "fix: close supervisor capacity bypasses"
```

### 任务 5：实现真实删除账号和离职历史保留

**文件：**
- 修改：`services/staff-lifecycle.js`
- 修改：`services/account-lifecycle.js`
- 修改：`routes/auth.js`
- 修改：`middleware/auth.js`
- 测试：`test/security-audit.test.js`
- 测试：`test/staff-lifecycle.test.js`
- 测试：`test/auth-security.test.js`

- [ ] **步骤 1：编写离职事务失败测试**

测试记录离职前后数量和关联：

```js
const before = historyCounts(db, targetUserId);
const result = departStaff(db, targetUserId, supervisorUser);
assert.equal(result.accountDeleted, true);
assert.equal(userById(db, targetUserId), null);
assert.equal(profile.employment_status, 'departed');
assert.equal(profile.user_id, null);
assert.match(profile.phone, /^138\*{4}0005$/);
assert.deepEqual(historyCountsByProfile(db, profile.id), before);
assert.equal(currentMemberships(db, profile.id), 0);
assert.equal(currentOrFutureAssignments(db, profile.id), 0);
```

同时断言唯一主管不能离职、重复离职幂等、事务触发失败时账号和历史均回滚。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/staff-lifecycle.test.js test/security-audit.test.js test/auth-security.test.js`

预期：FAIL，当前实现只把账号设为 disabled。

- [ ] **步骤 3：实现离职事务并删除用户行**

`departStaff` 事务核心：

```js
db.run('UPDATE tickets SET assignee_staff_profile_id = ?, assignee_user_id = NULL WHERE assignee_user_id = ?', [profile.id, userId]);
db.run('UPDATE ticket_activity_logs SET actor_staff_id = COALESCE(actor_staff_id, ?), actor_user_id = NULL WHERE actor_user_id = ?', [profile.id, userId]);
db.run(`UPDATE staff_profiles SET user_id = NULL, employment_status = 'departed',
  departed_at = ?, departed_by_user_id = ?, phone = ?, updated_at = ? WHERE id = ?`, values);
db.run('DELETE FROM users WHERE id = ?', [userId]);
```

当前/未来排班的判断使用上海时区日期；历史排班保留但日历服务排除 `departed`。

- [ ] **步骤 4：运行离职与认证测试**

运行：`node --test test/staff-lifecycle.test.js test/security-audit.test.js test/auth-security.test.js`

预期：PASS；使用离职前 JWT 请求受保护接口得到 401。

- [ ] **步骤 5：提交**

```bash
git add services/staff-lifecycle.js services/account-lifecycle.js routes/auth.js middleware/auth.js test/staff-lifecycle.test.js test/security-audit.test.js test/auth-security.test.js
git commit -m "feat: delete departed login and retain history"
```

### 任务 6：建立工单账号级读取权限

**文件：**
- 创建：`services/ticket-access.js`
- 修改：`routes/tickets.js`
- 测试：`test/ticket-scope.test.js`
- 测试：`test/ticket-community.test.js`
- 测试：`test/attachment-security.test.js`

- [ ] **步骤 1：编写列表、详情和附件越权失败测试**

用两个同名维修师傅证明姓名不能授权：

```js
const mine = await get('/api/tickets', workerA);
assert.deepEqual(mine.body.data.map(ticket => ticket.id).sort(), ['C-A', 'H-A', 'R-A']);
assert.equal((await get('/api/tickets/R-B', workerA)).response.status, 404);
assert.equal((await get('/api/tickets/R-B/photos', workerA)).response.status, 404);
assert.equal((await upload('/api/tickets/R-B/photos', workerA)).response.status, 404);
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/ticket-scope.test.js test/ticket-community.test.js test/attachment-security.test.js`

预期：FAIL，同小区人员可以读取他人工单。

- [ ] **步骤 3：实现统一访问服务并替换路由判断**

`services/ticket-access.js` 导出：

```js
function ticketReadScope(req, alias = '') {
  return isSupervisorUser(req.user)
    ? supervisorCommunityScope(req, alias)
    : { sql: ` AND ${prefix}assignee_user_id = ?`, params: [req.user.id] };
}
function canReadTicket(req, ticket) {
  return isSupervisorUser(req.user)
    ? canAccessCommunity(req, ticket.community_id)
    : Number(ticket.assignee_user_id) === Number(req.user.id);
}
```

集合、详情、附件上传与附件列表必须复用同一函数；普通员工越权读取统一返回 404。

- [ ] **步骤 4：运行工单读取权限测试**

运行：`node --test test/ticket-scope.test.js test/ticket-community.test.js test/attachment-security.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/ticket-access.js routes/tickets.js test/ticket-scope.test.js test/ticket-community.test.js test/attachment-security.test.js
git commit -m "fix: scope staff tickets by authenticated account"
```

### 任务 7：统一三类工单处理权限和稳定派单身份

**文件：**
- 修改：`services/ticket-access.js`
- 修改：`services/ticket-activity.js`
- 修改：`routes/tickets.js`
- 测试：`test/ticket-activity.test.js`
- 测试：`test/ticket-scope.test.js`

- [ ] **步骤 1：编写三类工单状态流失败测试**

对 `repair`、`complaint`、`help` 循环验证：

```js
for (const type of ['repair', 'complaint', 'help']) {
  assert.equal((await patch(ownTicket(type), { status: 'doing' }, worker)).response.status, 200);
  assert.equal((await patch(ownTicket(type), { status: 'confirm' }, worker)).response.status, 200);
  assert.equal((await patch(ownTicket(type), { status: 'done' }, worker)).response.status, 403);
  assert.equal((await patch(otherTicket(type), { status: 'confirm' }, worker)).response.status, 403);
}
```

另外断言员工不能修改 `worker`、小区、优先级或绩效规则字段。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/ticket-scope.test.js test/ticket-activity.test.js`

预期：FAIL，现有 PATCH 允许过宽字段或按工单类型区分处理人。

- [ ] **步骤 3：实现角色字段白名单和状态转换**

```js
const STAFF_MUTABLE_FIELDS = new Set(['status', 'message', 'metadata', 'rejectReason']);
const STAFF_TRANSITIONS = new Map([
  ['wait', new Set(['doing'])],
  ['doing', new Set(['wait', 'pending', 'confirm'])],
  ['pending', new Set(['doing', 'confirm'])],
  ['confirm', new Set()],
]);
```

派单时按唯一在职档案解析并同时写入：

```js
{ assigneeUserId, assigneeStaffProfileId, displayName }
```

不能通过同名人员产生歧义；不存在、离职或不属于主管团队的处理人返回 409。

- [ ] **步骤 4：运行三类工单操作测试**

运行：`node --test test/ticket-scope.test.js test/ticket-activity.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/ticket-access.js services/ticket-activity.js routes/tickets.js test/ticket-scope.test.js test/ticket-activity.test.js
git commit -m "feat: let workers process all assigned ticket types"
```

### 任务 8：同步日历、通讯录和报告的当前/历史范围

**文件：**
- 修改：`services/calendar.js`
- 修改：`routes/directory.js`
- 修改：`services/reporting.js`
- 修改：`routes/workforce-reports.js`
- 测试：`test/calendar.test.js`
- 测试：`test/directory.test.js`
- 测试：`test/reporting.test.js`

- [ ] **步骤 1：编写离职显示和当前范围失败测试**

```js
assert.equal(directory.some(item => item.employment_status === 'departed'), false);
assert.equal(calendar.staff.some(item => item.employmentStatus === 'departed'), false);
assert.equal(historyReport.assigneeDisplayName, '赵师傅（已离职）');
assert.equal(currentTeamReport.staffReports.length, 4);
```

普通员工日历还要断言只含 `assignee_user_id = req.user.id` 的工单。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/calendar.test.js test/directory.test.js test/reporting.test.js`

预期：FAIL，历史显示或当前范围尚未统一。

- [ ] **步骤 3：以人员档案状态区分当前与历史**

- 当前组织、通讯录、排班和团队报告查询加入 `employment_status = 'active'`。
- 历史工单和报告左连接 `assignee_staff_profile_id`，构造 `assigneeDisplayName`：

```sql
CASE WHEN sp.employment_status = 'departed'
  THEN sp.name || '（已离职）'
  ELSE COALESCE(sp.name, t.worker, '未指派')
END
```

- 普通员工日历工单条件仅使用当前用户 ID。

- [ ] **步骤 4：运行当前/历史数据流测试**

运行：`node --test test/calendar.test.js test/directory.test.js test/reporting.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/calendar.js routes/directory.js services/reporting.js routes/workforce-reports.js test/calendar.test.js test/directory.test.js test/reporting.test.js
git commit -m "feat: separate active staff from departed history"
```

### 任务 9：更新维修师傅和主管前端

**文件：**
- 修改：`public/app.js`
- 修改：`public/js/management-workspace.js`
- 修改：`public/index.html`
- 测试：`test/frontend-feature.test.js`
- 测试：`test/management-workspace-static.test.js`

- [ ] **步骤 1：编写前端静态失败测试**

```js
assert.doesNotMatch(appSource, /complaint.*display\s*=\s*isWorker\s*\?\s*'none'/s);
assert.match(appSource, /\['repair',\s*'complaint',\s*'help'\]/);
assert.match(managementSource, /TEAM_CAPACITY_FULL|ROLE_CAPACITY_FULL/);
assert.match(managementSource, /4\/4|totalLimit/);
```

测试还必须确认处理按钮不再以 `repair`/`keeper` 二选一限制维修师傅。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/frontend-feature.test.js test/management-workspace-static.test.js`

预期：FAIL，维修师傅入口仍被隐藏。

- [ ] **步骤 3：实现入口和操作展示**

- `applyRoleView()` 对维修师傅显示报修、投诉、帮助、已完成、我的。
- `renderTickets()` 只做类型和状态展示过滤，不再按姓名实现安全过滤。
- `buildActions()` 对三类本人工单共用处理、退回、搁置、上传和提交按钮。
- 管理工作台显示当前 `4/4`、维修 `3/3`、管家 `1/1`；审批 409 时显示服务端消息且申请保持可见。
- 历史列表直接展示服务端的 `assigneeDisplayName`。

- [ ] **步骤 4：运行前端测试**

运行：`node --test test/frontend-feature.test.js test/management-workspace-static.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add public/app.js public/js/management-workspace.js public/index.html test/frontend-feature.test.js test/management-workspace-static.test.js
git commit -m "feat: show all personal ticket types to workers"
```

### 任务 10：调整固定模拟数据和独立验证器

**文件：**
- 修改：`services/retained-test-data.js`
- 修改：`scripts/prepare-retained-test-data.js`
- 修改：`scripts/verify-retained-test-data.js`
- 修改：`test/retained-test-data.test.js`
- 修改：`test/prepare-retained-test-data.test.js`
- 修改：`test/verify-retained-test-data.test.js`

- [ ] **步骤 1：编写五账号、四在职、两离职失败测试**

```js
assert.deepEqual(activePhones(db), [
  '13800000001', '13800000002', '13800000003', '13800000004', '13800000006'
]);
assert.deepEqual(departedNames(db), ['赵师傅', '周管家']);
assert.deepEqual(teamUsage(db, supervisorProfileId), {
  total: 4, totalLimit: 4, worker: 3, workerLimit: 3, keeper: 1, keeperLimit: 1,
});
assert.equal(userByPhone(db, '13800000005'), null);
assert.equal(userByPhone(db, '13800000007'), null);
```

断言每名在职维修师傅都有本人投诉和帮助工单；两名离职人员只有完成历史工单。

- [ ] **步骤 2：运行专项测试确认失败**

运行：`node --test test/retained-test-data.test.js test/prepare-retained-test-data.test.js test/verify-retained-test-data.test.js`

预期：FAIL，当前迁移仍创建七个 active 账号和六名直属员工。

- [ ] **步骤 3：更新迁移数据和验证摘要**

- 保留五个账号密码哈希；删除两个离职人员的 `users` 行。
- 保留七份人员档案，其中主管一份、四份 active、两份 departed。
- 仅为四名 active 人员创建当前/未来排班和小区成员关系。
- 为三名维修师傅生成 `repair`、`complaint`、`help` 的本人样本和活动链。
- 将验证输出改为：

```js
{
  accounts: { active: 5, loginVerified: 5 },
  organization: { activeReports: 4, workers: 3, keepers: 1, departed: 2 },
  workerTicketScope: { workersWithComplaint: 3, workersWithHelp: 3 },
  historicalIdentity: { departedTickets: 2, labelled: 2 }
}
```

- [ ] **步骤 4：运行专项测试**

运行：`node --test test/retained-test-data.test.js test/prepare-retained-test-data.test.js test/verify-retained-test-data.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add services/retained-test-data.js scripts/prepare-retained-test-data.js scripts/verify-retained-test-data.js test/retained-test-data.test.js test/prepare-retained-test-data.test.js test/verify-retained-test-data.test.js
git commit -m "feat: seed four-person team and departed history"
```

### 任务 11：同步 API、安全和产品文档

**文件：**
- 修改：`docs/API.md`
- 修改：`docs/SECURITY-AUDIT.md`
- 修改：`README.md`
- 修改：`介绍.md`
- 测试：`test/security-audit.test.js`

- [ ] **步骤 1：更新安全静态测试**

要求文档与配置不包含测试明文密码，并描述真实删除账号和历史留存：

```js
assert.doesNotMatch(repositoryText, /Test@123456/);
assert.match(apiDoc, /TEAM_CAPACITY_FULL/);
assert.match(apiDoc, /账号已删除.*历史工单.*保留/s);
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/security-audit.test.js`

预期：FAIL，旧文档仍描述“停用并保留账号”。

- [ ] **步骤 3：同步文档**

明确记录：

- 一名主管、四名直属在职人员、3/1 岗位槽位；
- 离职事务和稳定人员档案；
- 三类工单的个人范围与状态权限；
- 生产迁移 dry-run、备份、验证和回滚顺序；
- 测试密码只能通过 `RETAINED_TEST_PASSWORD` 输入。

- [ ] **步骤 4：运行安全静态测试**

运行：`node --test test/security-audit.test.js`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add docs/API.md docs/SECURITY-AUDIT.md README.md 介绍.md test/security-audit.test.js
git commit -m "docs: document team capacity and departed history"
```

### 任务 12：完整验证并准备生产迁移

**文件：**
- 修改：`docs/superpowers/plans/2026-08-12-supervisor-team-capacity-and-worker-ticket-scope.md`

- [ ] **步骤 1：运行专项测试**

```bash
node --test --test-concurrency=1 \
  test/team-capacity.test.js \
  test/staff-lifecycle.test.js \
  test/auth-security.test.js \
  test/profiles-api.test.js \
  test/ticket-scope.test.js \
  test/ticket-activity.test.js \
  test/calendar.test.js \
  test/directory.test.js \
  test/reporting.test.js \
  test/frontend-feature.test.js \
  test/retained-test-data.test.js \
  test/verify-retained-test-data.test.js
```

预期：全部 PASS。

- [ ] **步骤 2：运行全量测试**

运行：`npm test`

预期：退出码 0，无失败测试。

- [ ] **步骤 3：运行代码和敏感信息检查**

```bash
git diff --check
rg -n --hidden --glob '!data.db*' --glob '!*.7z' --glob '!.git/**' \
  'Test@123456|sb_secret_[A-Za-z0-9_-]{16,}|SUPABASE_SERVICE_ROLE_KEY\s*=|AI_API_KEY\s*=' .
```

预期：`git diff --check` 无输出；扫描只允许环境变量占位符和专用测试假密钥，不包含真实测试密码或生产密钥。

- [ ] **步骤 4：对独立候选数据库执行 dry-run、apply 和 verify**

```bash
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:dry-run -- --source=/absolute/path/candidate.db
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:apply -- --source=/absolute/path/candidate.db
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:verify -- --source=/absolute/path/candidate.db
```

预期：验证器返回 `ok: true`、`active: 5`、`activeReports: 4`、`departed: 2`，且原始备份文件存在。

- [ ] **步骤 5：提交最终验证记录**

```bash
git add docs/superpowers/plans/2026-08-12-supervisor-team-capacity-and-worker-ticket-scope.md
git commit -m "test: verify supervisor team lifecycle flows"
```

上线前必须另行确认 Render 持久化数据库和 Supabase 对象均已备份；在没有备份和线上数据库访问权限时，不得把本地 `data.db` 推送或覆盖生产数据。
