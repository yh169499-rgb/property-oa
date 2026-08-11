# 千问大模型工单报告增强实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有确定性人员报告上增加按需调用千问的正式化润色报告，固定输出整体总结、亮点、问题、趋势、风险和可执行建议，同时保护隐私、免费额度与原报告可用性。

**架构：** 服务端先复用 `getStaffReport()` 生成权威统计，再构造不含姓名、手机号、ID、地址和原始工单文本的聚合载荷，通过 OpenAI 兼容接口调用 `qwen3.6-flash`。结构化结果经过白名单清洗后写入 SQLite 缓存；前端把它作为“AI 润色报告”插入原报告，并纳入复制、打印和 Word 导出。

**技术栈：** Node.js、Express、sql.js、node-fetch、原生 JavaScript、Node test、阿里云百炼 OpenAI 兼容 API、Render。

---

## 文件范围锁定

- 创建：`services/ai-report.js`，负责脱敏、提示词、供应商调用、结构校验、错误映射和缓存。
- 创建：`routes/ai-reports.js`，负责状态查询、权限、小区范围、限速和分析接口。
- 修改：`workforce-schema.js`，增加 AI 报告缓存表和唯一索引。
- 修改：`config.js`，读取服务端 AI 环境变量。
- 修改：`server-app.js`，挂载 AI 报告路由。
- 修改：`public/js/workforce-api.js`，增加 AI 状态和分析请求。
- 修改：`public/js/staff-report.js`，增加按钮、加载状态、安全渲染及导出合并。
- 修改：`public/styles.css`，增加 AI 润色报告卡片的响应式样式。
- 修改：`render.yaml`、`README.md`，记录不含密钥的部署配置步骤。
- 创建：`test/ai-report.test.js`，覆盖脱敏、提示词、清洗、缓存和供应商错误。
- 创建：`test/ai-report-route.test.js`，覆盖登录、人员/小区权限、状态和接口回退。
- 修改：`test/frontend-feature.test.js`，覆盖 AI 按钮、六段式润色和导出。
- 修改：`test/workforce-schema.test.js`、`test/config-env.test.js`，覆盖缓存结构和环境变量。

### 任务 1：数据库缓存与环境配置

**文件：**

- 修改：`workforce-schema.js`
- 修改：`config.js`
- 测试：`test/workforce-schema.test.js`
- 测试：`test/config-env.test.js`

- [ ] **步骤 1：编写失败测试**

增加缓存表、唯一索引和 AI 配置断言：

```js
assert.ok(tableNames(db).includes('ai_report_analyses'));
assert.ok(columns(db, 'ai_report_analyses').has('report_hash'));
assert.ok(indexNames(db, 'ai_report_analyses').includes('uq_ai_report_cache'));
assert.equal(config.AI_REPORT_ENABLED, true);
assert.equal(config.AI_MODEL, 'qwen3.6-flash');
assert.equal(config.AI_TIMEOUT_MS, 30000);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/workforce-schema.test.js test/config-env.test.js`

预期：缓存表或 AI 配置字段不存在，测试以断言失败结束。

- [ ] **步骤 3：实现最少结构与配置**

在 `ensureWorkforceSchema()` 中创建：

```sql
CREATE TABLE IF NOT EXISTS ai_report_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_profile_id INTEGER NOT NULL,
  community_id TEXT NOT NULL DEFAULT '',
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_report_cache
ON ai_report_analyses(report_hash, model, prompt_version);
```

在 `config.js` 中读取 `AI_REPORT_ENABLED`、`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_TIMEOUT_MS`、`AI_REPORT_PROMPT_VERSION`，对超时使用正整数校验和 30000 默认值。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/workforce-schema.test.js test/config-env.test.js`

预期：所有结构迁移可重复执行，配置断言通过。

### 任务 2：脱敏、润色提示词与结构化响应

**文件：**

- 创建：`services/ai-report.js`
- 创建：`test/ai-report.test.js`

- [ ] **步骤 1：编写脱敏与润色失败测试**

测试公开 API：

```js
const payload = sanitizeReport(report, filters);
assert.equal(payload.staff.role, '维修师傅');
assert.equal(JSON.stringify(payload).includes('13800138000'), false);
assert.equal(JSON.stringify(payload).includes('张师傅'), false);
assert.match(buildMessages(payload)[0].content, /正式、清晰、可直接用于管理汇报/);
assert.match(buildMessages(payload)[0].content, /不得修改或编造数字/);
```

并测试 `cleanAnalysis()` 仅保留 `summary/highlights/issues/trends/risks/recommendations`，去掉 HTML、控制字符、未知字段，限制摘要 600 字、数组 6 项、单项 200 字。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/ai-report.test.js`

预期：`services/ai-report.js` 不存在或导出函数缺失。

- [ ] **步骤 3：实现纯函数**

导出以下稳定接口：

```js
sanitizeReport(report, filters)
buildMessages(payload)
cleanAnalysis(input)
reportHash(payload, model, promptVersion)
mapProviderError(status, body)
```

系统提示词必须要求：保留全部统计事实；以正式物业管理报告口吻润色；摘要先结论后依据；建议必须具体、可执行并与输入数据对应；数据不足时明确写“数据不足以判断”；只输出六字段 JSON。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/ai-report.test.js`

预期：脱敏、长度限制、HTML 清洗、哈希稳定性和错误映射测试全部通过。

### 任务 3：千问调用、缓存与失败回退

**文件：**

- 修改：`services/ai-report.js`
- 修改：`test/ai-report.test.js`

- [ ] **步骤 1：编写供应商调用失败测试**

使用注入的 `fetchImpl` 测试：

```js
const result = await analyzeReport({ db, report, filters, config, fetchImpl });
assert.equal(result.analysis.summary, '本期整体表现稳定。');
assert.equal(result.cached, false);
const cached = await analyzeReport({ db, report, filters, config, fetchImpl: failIfCalled });
assert.equal(cached.cached, true);
```

另测超时、401、429、额度耗尽、5xx、非 JSON、HTML 内容；验证 Authorization 只出现在请求头，不进入日志、缓存或错误响应。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/ai-report.test.js`

预期：`analyzeReport()` 尚未实现或不会缓存。

- [ ] **步骤 3：实现最少调用与缓存**

`analyzeReport()` 执行：配置检查 → 脱敏 → SHA-256 → 缓存查询 → 30 秒 AbortController → `POST {AI_BASE_URL}/chat/completions` → 白名单清洗 → 写缓存 → `database.saveDB()`。请求体包含：

```js
{
  model: config.AI_MODEL,
  messages: buildMessages(payload),
  response_format: { type: 'json_object' },
  temperature: 0.2,
  max_tokens: 1800
}
```

网络错误或 429/5xx 最多重试一次；401/403、配额耗尽、400 和无效响应不重试。错误对象只暴露稳定 `status/code/message`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/ai-report.test.js`

预期：首次调用写缓存，第二次不调用供应商；错误码和清洗断言通过。

### 任务 4：分析接口、权限与限速

**文件：**

- 创建：`routes/ai-reports.js`
- 修改：`server-app.js`
- 创建：`test/ai-report-route.test.js`

- [ ] **步骤 1：编写路由失败测试**

覆盖：未登录 401；普通员工只能分析自己；主管可分析递归下级；跨树 403；无授权小区 403；日期错误 400；未配置 503；已配置成功返回六字段；连续第六次未缓存请求返回 429。

```js
assert.equal(anonymous.status, 401);
assert.equal(forbidden.body.code, 'REPORT_SCOPE_FORBIDDEN');
assert.equal(notConfigured.body.code, 'AI_REPORT_NOT_CONFIGURED');
assert.deepEqual(Object.keys(success.body.data.analysis).sort(), expectedFields);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/ai-report-route.test.js`

预期：新接口返回 404。

- [ ] **步骤 3：实现状态与分析接口**

新增：

```text
GET  /api/reports/ai/status
POST /api/reports/staff/:staff_id/ai-analysis
```

状态接口只返回 `enabled` 和模型名，不返回 Base URL 或密钥。分析接口复用人员树权限，校验 `from/to/community_id`，调用 `getStaffReport()` 后才进入 AI 服务。路由级 `express-rate-limit` 使用每用户 1 分钟 5 次，并返回 `AI_REPORT_RATE_LIMITED`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/ai-report-route.test.js test/reporting.test.js`

预期：新接口权限测试通过，既有人员报告接口不回归。

### 任务 5：前端 AI 润色报告与导出

**文件：**

- 修改：`public/js/workforce-api.js`
- 修改：`public/js/staff-report.js`
- 修改：`public/styles.css`
- 修改：`test/frontend-feature.test.js`

- [ ] **步骤 1：编写前端失败测试**

增加静态和纯函数断言：

```js
assert.match(reportSource, /AI 润色报告/);
assert.match(reportSource, /整体总结|工作亮点|主要问题|趋势判断|风险提醒|后续建议/);
assert.match(reportSource, /AI 建议，仅供管理参考/);
assert.match(apiSource, /ai-analysis/);
assert.doesNotMatch(reportSource, /analysis\.summary[^\n]*innerHTML/);
```

在可导出函数测试中传入 AI 结果，断言 `reportText()` 和 `reportHtml()` 都包含摘要、风险和建议；没有 AI 结果时仍生成原报告。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/frontend-feature.test.js`

预期：AI 文案、API 和导出内容断言失败。

- [ ] **步骤 3：实现按需润色交互**

`StaffReport.render()` 保存当前 `report/filters/analysis` 状态，原报告成功后显示“AI 优化并润色”按钮。点击后禁用按钮并显示“千问正在整理报告…”，调用 `WorkforceAPI.aiStaffReport()`；成功后重新渲染包含六段式 AI 卡片的报告，并把按钮改为“重新查看 AI 润色”。

输出结构：

```html
<section class="staff-report-ai">
  <header><h3>AI 润色报告</h3><span>千问生成 · 仅供管理参考</span></header>
  <section><h4>整体总结</h4><p>...</p></section>
  <section><h4>工作亮点</h4><ul>...</ul></section>
  <!-- 问题、趋势、风险、建议使用相同安全文本渲染 -->
</section>
```

复制、打印、Word 导出始终读取当前分析状态；所有模型内容先 `escapeHtml()`，禁止直接拼入未转义 HTML。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/frontend-feature.test.js test/management-workspace-static.test.js`

预期：六段式润色、导出、安全渲染和原报告兼容测试通过。

### 任务 6：部署说明、完整验证与上线

**文件：**

- 修改：`render.yaml`
- 修改：`README.md`

- [ ] **步骤 1：补充无密钥配置说明**

在 `render.yaml` 只声明非秘密默认项，不写 API Key：

```yaml
- key: AI_REPORT_ENABLED
  value: "false"
- key: AI_BASE_URL
  value: https://dashscope.aliyuncs.com/compatible-mode/v1
- key: AI_MODEL
  value: qwen3.6-flash
- key: AI_TIMEOUT_MS
  value: "30000"
- key: AI_REPORT_PROMPT_VERSION
  value: report-analysis-v1
- key: AI_API_KEY
  sync: false
```

README 说明在百炼创建 API Key、开启“免费额度用完即停”、在 Render 设置密钥并把 `AI_REPORT_ENABLED` 改为 `true`。

- [ ] **步骤 2：运行专项测试**

运行：

```bash
node --test --test-concurrency=1 test/ai-report.test.js test/ai-report-route.test.js test/workforce-schema.test.js test/config-env.test.js test/frontend-feature.test.js test/reporting.test.js
```

预期：所有专项测试通过，0 失败。

- [ ] **步骤 3：运行完整测试和语法检查**

运行：

```bash
npm test
node --check services/ai-report.js
node --check routes/ai-reports.js
node --check public/js/staff-report.js
```

预期：完整测试 0 失败；三个语法检查退出码均为 0。

- [ ] **步骤 4：提交与推送**

只提交本计划列出的代码、测试和文档，不提交 `data.db`、Supabase 密钥或其他本地数据：

```bash
git add config.js workforce-schema.js server-app.js services/ai-report.js routes/ai-reports.js public/js/workforce-api.js public/js/staff-report.js public/styles.css render.yaml README.md test/ai-report.test.js test/ai-report-route.test.js test/workforce-schema.test.js test/config-env.test.js test/frontend-feature.test.js docs/superpowers/plans/2026-08-11-ai-report-enhancement.md
git commit -m "feat: add qwen polished report analysis"
git push origin master
```

- [ ] **步骤 5：配置生产环境并验收**

在 Render 增加 `AI_API_KEY`，将 `AI_REPORT_ENABLED=true`，重新部署后验证：原报告 → 点击 AI 优化并润色 → 显示六段式报告 → 复制/打印/Word 均包含 AI 内容 → 再次点击命中缓存 → 模型失败时原报告仍存在。
