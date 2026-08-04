# 班次模板、统一日程与个人日程实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有排班、考勤、工单数据之上，完成班次模板管理、全员日程查看、个人日程卡片和统一视觉，并提供幂等测试种子数据。

**架构：** 服务端继续使用 Express + sql.js。新增模板删除接口在删除前检查排班引用；日历接口继续按登录角色限制范围，个人页只调用自身日历数据。管理工作台设置页负责模板 CRUD，排班页复用同一模板缓存；“我的”页新增日程卡片，复用 `/api/calendar/day` 的班次、考勤、工单聚合结果。

**技术栈：** Node.js、Express、sql.js、原生 JavaScript、现有 CSS 变量和 Node Test Runner。

---

### 任务 1：补充模板删除和日历聚合测试

**文件：**
- 修改：`test/shifts.test.js`
- 修改：`test/calendar.test.js`

- [ ] **步骤 1：编写失败测试**

在 `test/shifts.test.js` 增加 HTTP 测试：管理员删除未引用模板返回 200；删除已被 `shift_assignments.template_id` 引用的模板返回 409 和 `SHIFT_TEMPLATE_IN_USE`；普通用户删除返回 403。

在 `test/calendar.test.js` 增加断言：日历人员的班次包含模板名称/颜色；普通用户访问自身日历时返回班次、考勤和本人工单事件。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test test/shifts.test.js test/calendar.test.js`

预期：新增模板删除请求失败为 404，模板信息断言失败，说明生产实现尚未完成。

- [ ] **步骤 3：记录测试边界**

确保测试数据库使用 `createTestDB()` 和 `ensureWorkforceSchema()`，不读取工作区 `data.db`，并沿用 `authHeader({ id, role })`。

### 任务 2：实现模板删除接口和日历模板字段

**文件：**
- 修改：`routes/shifts.js:104-108`
- 修改：`services/calendar.js:128-174`

- [ ] **步骤 1：实现最小服务端代码**

新增 `DELETE /api/shift-templates/:id`，先查模板是否存在，再查询 `shift_assignments` 引用；有引用时返回 409、`SHIFT_TEMPLATE_IN_USE`，无引用时删除并保存数据库。

日历查询将 `shift_assignments` 与 `shift_templates` 关联，向 `people[].shift` 返回 `templateId`、`templateName`、`templateColor`、`startAt`、`endAt`。

- [ ] **步骤 2：运行测试确认绿灯**

运行：`node --test test/shifts.test.js test/calendar.test.js`

预期：新增删除、引用保护、角色权限和日历模板字段测试全部通过。

- [ ] **步骤 3：提交任务**

运行 `git diff --check` 后，仅提交 `routes/shifts.js`、`services/calendar.js` 和两份测试文件，提交信息：`feat: add shift template deletion and calendar template details`。

### 任务 3：实现设置页班次模板 CRUD

**文件：**
- 修改：`public/js/management-workspace.js:720-805`
- 修改：`public/styles.css:1068-1080`
- 测试：`test/management-template-ui.test.js`

- [ ] **步骤 1：编写失败的静态 UI 测试**

读取脚本源码并断言设置页包含“班次模板”、新增/编辑/删除操作、`/api/shift-templates` 的 `POST`、`PATCH`、`DELETE` 请求和 `SHIFT_TEMPLATE_IN_USE` 文案。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test test/management-template-ui.test.js`

预期：由于设置页当前只有系统设置卡片，测试失败。

- [ ] **步骤 3：实现设置页模板管理**

在设置页增加模板卡片区域、刷新按钮、新增按钮和复用的新增/编辑模态表单。表单字段为名称、上班时间、下班时间、颜色、迟到宽限分钟；提交失败显示服务端错误，删除先 `window.confirm`，引用保护显示“该模板正在被排班使用，不能删除”。

模板保存成功后更新当前模板列表，并让排班页下一次加载读取最新模板。

- [ ] **步骤 4：运行测试确认绿灯**

运行：`node --test test/management-template-ui.test.js` 和 `node --check public/js/management-workspace.js`。

- [ ] **步骤 5：提交任务**

运行 `git diff --check`，提交管理工作台脚本、样式和测试，提交信息：`feat: manage shift templates from settings`。

### 任务 4：实现“我的日程”数据模型和卡片

**文件：**
- 修改：`public/js/my-page.js:6-215,286-325`
- 修改：`public/styles.css:1097-1157`
- 测试：`test/my-page.test.js`

- [ ] **步骤 1：编写失败测试**

扩展 `buildMyPageModel` 测试，传入日历响应，断言模型包含本人班次、考勤状态、工单时间块和冲突标识；无班次/无工单时返回明确空状态。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test test/my-page.test.js`

预期：当前模型没有日历字段，新增断言失败。

- [ ] **步骤 3：实现最小模型和渲染**

为 `state` 增加 `calendarDate` 与 `calendar`，加载 `/api/calendar/day?date=YYYY-MM-DD`，把 `people` 中当前用户对应记录映射为日程模型；渲染“我的日程”卡片、日期前后切换、班次时间、考勤、工单时间块及冲突提示。普通用户不拼接人员 ID，直接使用服务端强制返回的自身数据。

- [ ] **步骤 4：运行测试确认绿灯**

运行：`node --test test/my-page.test.js`、`node --check public/js/my-page.js`。

- [ ] **步骤 5：提交任务**

提交个人页脚本、样式和测试，提交信息：`feat: show personal schedule on my page`。

### 任务 5：统一管理工作台和工单详情视觉

**文件：**
- 修改：`public/styles.css`
- 修改：`public/index.html`（仅在缺少语义容器时调整）
- 测试：`test/unified-visual-style.test.js`

- [ ] **步骤 1：编写失败测试**

静态检查统一渐变令牌、白色圆角卡片、窄屏纵向日程规则，以及管理工作台和工单详情使用对应类名。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test test/unified-visual-style.test.js`

预期：旧管理工作台样式缺少统一头部/窄屏日程规则，测试失败。

- [ ] **步骤 3：实现样式**

补充 `.management-hero`、`.management-card`、`.my-schedule-card`、`.schedule-agenda` 等样式，沿用 `#123f78 → #1f7cf0` 渐变、18px 圆角和 768px 断点；不重构现有业务布局。

- [ ] **步骤 4：运行测试确认绿灯**

运行：`node --test test/unified-visual-style.test.js` 和 `git diff --check`。

- [ ] **步骤 5：提交任务**

提交样式与必要的 HTML 调整，提交信息：`style: unify schedule and workspace visual language`。

### 任务 6：添加幂等测试种子脚本

**文件：**
- 创建：`scripts/seed-workforce-demo.js`
- 修改：`package.json`
- 测试：`test/seed-workforce-demo.test.js`

- [ ] **步骤 1：编写失败测试**

在临时 `DB_PATH` 上运行种子函数两次，断言模板、排班、考勤和工单数量第二次不增加，输出不包含密码或 JWT。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --test test/seed-workforce-demo.test.js`

预期：脚本不存在，测试失败。

- [ ] **步骤 3：实现脚本**

导出 `seedDemo(db, now)`，固定测试账号手机号和模板/排班/工单前缀；用查询后插入/更新保证幂等。命令行仅在 `SEED_WORKFORCE_DEMO=true` 时允许指定外部数据库，默认使用显式 `DB_PATH`；输出统计数量，不输出凭据。

- [ ] **步骤 4：运行测试确认绿灯**

运行：`node --test test/seed-workforce-demo.test.js` 和 `node scripts/seed-workforce-demo.js --help`。

- [ ] **步骤 5：提交任务**

提交脚本、package 命令和测试，提交信息：`test: add idempotent workforce demo seed`。

### 任务 7：整体验证与交付检查

**文件：**
- 修改：无

- [ ] **步骤 1：运行针对性测试**

运行：`npm run test:workforce`、`node --test test/auth-token-sync.test.js test/config-env.test.js`、`node --check public/js/management-workspace.js public/js/my-page.js`。

- [ ] **步骤 2：检查差异和需求覆盖**

运行 `git diff --check`、`git status --short`，确认不包含 `data.db`、`.superpowers/`、备份数据库或压缩包；逐项核对设计规格中的接口、角色、视觉、种子和错误文案。

- [ ] **步骤 3：提交整合变更**

按实际验证结果提交剩余修复，且不将测试密码写入前端或提交到 GitHub。

