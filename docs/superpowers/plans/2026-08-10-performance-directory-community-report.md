# 绩效评分、同小区通讯录、工单归属与人员报告实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将绩效评分、员工手机号可见范围、工单小区归属和人员报告统一接入服务端数据库，并部署到线上。

**架构：** 新增版本化绩效规则表、稳定 ID 小区成员关系表和工单规则版本字段；服务端集中完成评分和小区解析，前端只负责展示。主管在管理工作台设置规则，师傅/管家从已验证的小区通讯录读取手机号，报告复用现有人员/日期/小区筛选并返回评分依据。

**技术栈：** Node.js、Express、SQLite/sql.js、原生 JavaScript、Node test、Render。

---

## 文件范围锁定

- 创建：`services/performance.js`，统一评分规则读取、校验和计算。
- 创建：`services/community-resolution.js`，统一小区解析和错误码。
- 修改：`workforce-schema.js`，新增规则版本、成员关系和工单规则字段。
- 修改：`db.js`，兼容旧数据库迁移和唯一索引。
- 修改：`routes/settings.js`，增加绩效规则读取与发布接口。
- 修改：`routes/profiles.js` 或新建 `routes/directory.js`，增加同小区通讯录接口。
- 修改：`routes/tickets.js`，创建和修改工单使用小区解析服务，并冻结评分版本。
- 修改：`services/reporting.js`、`routes/workforce-reports.js`，输出绩效结果并移除考勤结果。
- 修改：`public/js/management-workspace.js`，设置页评分规则表单和报告评分展示。
- 修改：`public/js/my-page.js`、`public/js/worker-home.js`，同小区通讯录卡片。
- 修改：`public/app.js`，删除旧 `performanceScore()` 和旧绩效表数据源。
- 测试：`test/workforce-schema.test.js`、`test/performance.test.js`、`test/directory.test.js`、`test/ticket-community.test.js`、`test/reporting.test.js`、`test/management-workspace-static.test.js`。

### 任务 1：数据库结构与迁移

**目标：** 给评分规则、工单规则版本和小区成员关系建立可重复迁移。

**文件：**

- 修改：`workforce-schema.js`、`db.js`
- 测试：`test/workforce-schema.test.js`

- [ ] **步骤 1：编写失败测试**

增加测试断言：

```js
assert.ok(tableNames(db).includes('community_memberships'));
assert.ok(tableNames(db).includes('performance_rule_versions'));
assert.ok(columns(db, 'tickets').has('performance_rule_version_id'));
assert.ok(uniqueIndex(db, 'community_memberships', ['community_id', 'staff_profile_id']));
```

测试旧数据库只含 `tickets`、`communities`、`community_permissions` 时，执行迁移两次不会报错，唯一姓名能回填为成员 ID，同名记录不会自动授权。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/workforce-schema.test.js`

预期：新表和新列断言失败，而非测试文件语法错误。

- [ ] **步骤 3：实现最少迁移**

创建 `performance_rule_versions`、`community_memberships`，为 `tickets` 增加 `performance_rule_version_id`，并创建默认规则版本 1。迁移过程使用 `CREATE TABLE IF NOT EXISTS`、`ALTER TABLE` 前检查 `PRAGMA table_info`，成员回填只接受唯一姓名。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/workforce-schema.test.js`

预期：全部通过，且重复初始化不产生重复版本或重复成员。

- [ ] **步骤 5：Commit**

```bash
git add workforce-schema.js db.js test/workforce-schema.test.js
git commit -m "feat: add performance and community membership schema"
```

### 任务 2：服务端绩效规则和计算

**目标：** 让所有综合评分由服务端按冻结规则计算。

**文件：**

- 创建：`services/performance.js`
- 修改：`services/reporting.js`、`routes/settings.js`
- 测试：`test/performance.test.js`

- [ ] **步骤 1：编写失败测试**

覆盖以下行为：权重非 100、分界线逆序、普通员工发布规则、规则发布生成新版本、无样本返回 `insufficient_sample`、三维度按权重计算 86.5 分、单项无有效样本时剩余权重归一化、旧工单仍使用旧规则。

核心期望：

```js
assert.equal(result.status, 'scored');
assert.equal(result.score, 86.5);
assert.deepEqual(result.ruleVersions.map(v => v.version), [1, 2]);
assert.equal(empty.status, 'insufficient_sample');
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/performance.test.js`

预期：模块缺失或评分结果缺失导致失败。

- [ ] **步骤 3：实现服务和接口**

在 `services/performance.js` 导出 `validateRule(input)`、`getActiveRule(db)`、`createRuleVersion(db, input, actorId)`、`scoreStaff(db, staffId, filters)`。统一返回 `status`、`score`、`level`、`sampleSize`、`components`、`ruleVersions`。

在 `routes/settings.js` 增加：

- `GET /api/settings/performance`
- `POST /api/settings/performance/versions`（`requireAdmin`）

发布过程使用事务，历史行只读。

- [ ] **步骤 4：接入报告取数**

让 `getStaffReport()`使用接单集合、规则版本和评分服务；按工单的 `performance_rule_version_id` 分组后按样本数加权。删除报告返回中的 `attendance`。

- [ ] **步骤 5：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/performance.test.js test/reporting.test.js`

预期：新增评分测试通过，既有报告测试中与考勤字段有关的断言按已确认新口径更新，其余权限、日期和历史工单断言通过。

- [ ] **步骤 6：Commit**

```bash
git add services/performance.js services/reporting.js routes/settings.js test/performance.test.js test/reporting.test.js
git commit -m "feat: add versioned server-side performance scoring"
```

### 任务 3：小区成员关系和同小区通讯录

**目标：** 员工只能看到已验证小区内在职人员的必要联系方式。

**文件：**

- 创建或修改：`routes/directory.js`、`server-app.js`
- 修改：`routes/communities.js`、`routes/profiles.js`
- 测试：`test/directory.test.js`

- [ ] **步骤 1：编写失败测试**

覆盖：未登录 401、同小区可见、跨小区 403、停用人员不可见、同名不串权、返回不包含 `user_id`/出生年月/入职日期、修改手机号后返回新值。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/directory.test.js`

预期：通讯录路由不存在或权限断言失败。

- [ ] **步骤 3：实现接口**

新增 `GET /api/staff/directory?community_id=`，服务端通过登录用户对应的 `staff_profiles.user_id` 验证成员关系，使用字段白名单返回 `id,name,position,skill,phone`。主管保留现有组织权限，普通人员拒绝跨小区。

小区管理保存权限时同步写 `community_memberships`，旧姓名表只作兼容读取。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/directory.test.js test/profiles-api.test.js`

预期：通讯录和原有本人资料手机号同步测试通过。

- [ ] **步骤 5：Commit**

```bash
git add routes/directory.js routes/communities.js routes/profiles.js server-app.js test/directory.test.js
git commit -m "feat: add scoped staff directory"
```

### 任务 4：工单小区解析与规则冻结

**目标：** 多小区创建工单不再静默进入 `default`，单小区旧调用保持可用。

**文件：**

- 创建：`services/community-resolution.js`
- 修改：`routes/tickets.js`
- 测试：`test/ticket-community.test.js`

- [ ] **步骤 1：编写失败测试**

覆盖以下输入：单小区缺省、多小区缺省、合法 `community_id`、合法 `communityId`、两字段冲突、未知 ID、唯一名称、重名名称、修改工单小区。

示例期望：

```js
assert.equal(single.record.community_id, 'only-community');
assert.equal(multi.status, 400);
assert.equal(multiBody.code, 'COMMUNITY_REQUIRED');
assert.equal(unknownBody.code, 'COMMUNITY_NOT_FOUND');
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/ticket-community.test.js`

预期：当前代码会把缺省值写入 `default`，未知 ID 也会成功，测试失败。

- [ ] **步骤 3：实现解析服务**

实现 `resolveCommunity(db, body)`，按 ID 冲突、ID 存在性、名称唯一性、单小区兜底顺序返回 `{id,name,resolution}`；错误对象带稳定 `status` 和 `code`。

在 POST 和 PATCH 中调用解析服务，并在创建或首次成功派单时写入当前生效的 `performance_rule_version_id`。成功响应附带 `community_resolution` 和小区名称。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/ticket-community.test.js test/calendar.test.js test/reporting.test.js`

预期：小区归属和历史列表/报告筛选测试通过。

- [ ] **步骤 5：Commit**

```bash
git add services/community-resolution.js routes/tickets.js test/ticket-community.test.js
git commit -m "fix: require valid community for ticket creation"
```

### 任务 5：前端设置、通讯录与报告展示

**目标：** 把三条新服务端能力接入主管、师傅和管家页面，删除旧绩效和考勤展示。

**文件：**

- 修改：`public/js/management-workspace.js`
- 修改：`public/js/my-page.js`、`public/js/worker-home.js`
- 修改：`public/js/staff-report.js`、`public/app.js`
- 测试：`test/management-workspace-static.test.js`、`test/my-page.test.js`、`test/worker-home.test.js`

- [ ] **步骤 1：编写失败静态测试**

断言：设置页存在评分权重、阈值、版本发布入口；我的页面存在通讯录请求和手机号展示；报告存在 `performance` 展示且不存在考勤文案；旧 `performanceScore()` 和本地 `state.tickets` 评分路径不存在。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/management-workspace-static.test.js test/my-page.test.js test/worker-home.test.js`

预期：新设置、通讯录和评分展示断言失败。

- [ ] **步骤 3：实现设置页**

在 `renderSettings()` 增加规则表单；输入改变时显示权重总和；发布调用 `POST /api/settings/performance/versions`，成功后重新读取当前版本和历史。

- [ ] **步骤 4：实现通讯录卡片**

在员工个人中心从当前小区 ID 调用 `/api/staff/directory`，展示必要字段，切换小区后重新加载；不从 `localStorage` 或 `data.js` 补手机号。

- [ ] **步骤 5：实现报告评分**

在 `staff-report.js` 渲染综合分、等级、样本不足状态、三项贡献、规则版本和计算依据；移除考勤段落及导出文本。主管人员详情显示数据库手机号。

- [ ] **步骤 6：删除旧前端评分路径**

删除旧 `performanceScore()`、旧绩效表渲染和按姓名从浏览器数据计算分数的调用；旧隐藏图表不再作为权威数据源。

- [ ] **步骤 7：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/management-workspace-static.test.js test/my-page.test.js test/worker-home.test.js`

预期：所有静态和模型测试通过，页面代码无考勤模块和旧绩效公式。

- [ ] **步骤 8：Commit**

```bash
git add public/js/management-workspace.js public/js/my-page.js public/js/worker-home.js public/js/staff-report.js public/app.js test/management-workspace-static.test.js test/my-page.test.js test/worker-home.test.js
git commit -m "feat: add performance settings directory and report score"
```

### 任务 6：集成验证与部署

**文件：**

- 可能修改：`README.md`、部署配置或接口示例文档
- 测试：全部 `test/**/*.test.js`，以及生产页面关键路径

- [ ] **步骤 1：执行专项测试**

运行：`node --test --test-concurrency=1 test/performance.test.js test/directory.test.js test/ticket-community.test.js test/reporting.test.js test/management-workspace-static.test.js`

- [ ] **步骤 2：执行全量测试**

运行：`npm test`

预期：0 failures；如果监听端口被沙箱拒绝，使用允许本地测试端口的环境重跑，不把环境权限错误当作业务失败。

- [ ] **步骤 3：检查变更范围**

运行：`git diff --check`、`git status --short`、`git diff --stat 25c6f9f..HEAD`。确认 `data.db`、`.superpowers/`、备份和压缩包未被暂存。

- [ ] **步骤 4：提交集成版本**

```bash
git add README.md
git commit -m "docs: document community and performance APIs"
```

如果无需文档变化，不创建空提交。

- [ ] **步骤 5：推送并部署**

推送包含实施提交的分支，触发 Render 部署；等待构建和启动日志确认数据库迁移成功。

- [ ] **步骤 6：生产验证清单**

在生产环境分别使用主管、师傅、管家账号验证：

1. 主管发布评分规则，新版本出现在设置历史列表。
2. 同小区师傅/管家能看到彼此新手机号，跨小区不可见。
3. 单小区旧工单创建不传小区仍成功，多小区缺省创建返回 `COMMUNITY_REQUIRED`。
4. 报告选择指定人员、日期、小区后显示评分依据，不显示考勤。
5. 服务重启后规则版本、成员关系和工单小区字段保持。

- [ ] **步骤 7：Commit/部署回执**

记录最终 commit、Render 部署状态、专项测试结果和生产验证结果；若有失败，只报告实际失败点和下一步，不宣称完成。
