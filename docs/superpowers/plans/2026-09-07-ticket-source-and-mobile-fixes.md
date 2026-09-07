# 预警来源审计、移动端工单详情与转单闭环实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法跟踪进度。

**目标：** 在不破坏现有多租户和消息提醒功能的前提下，补齐原文/反馈人映射、建立预警与工单的可追溯关联、修复移动端工单详情布局，并让退回/驳回支持重新派单且持续提醒主管。

**架构：** 外部 POST 在服务端解析企业与小区后，在同一事务写入工单和来源审计记录；消息发送带可定位工单号，管理端可按租户查询审计。工单转派统一由服务端鉴权，退回/驳回保留历史原因并回到可重新派单状态。

**技术栈：** Node.js、Express、sql.js、原生 JavaScript、CSS、node:test、Multer、秒回消息接口。

---

## 文件结构

- 创建：services/ticket-source-audit.js，定义来源审计表、字段归一化、写入和查询。
- 修改：services/tenant-schema.js，创建来源审计表及索引。
- 修改：routes/tickets.js，保存审计、补齐兼容字段、提供租户范围审计查询、调整退回/驳回后的转单逻辑。
- 修改：services/jzm-messaging.js，统一原文清洗、消息正文换行和工单定位信息。
- 修改：public/app.js、public/styles.css，修复移动端抽屉、照片、操作按钮和转单交互。
- 修改：test/ticket-source-audit.test.js、test/jzm-ticket-alerts.test.js、test/ticket-scope.test.js、test/ticket-ui-regressions.test.js。
- 创建：docs/superpowers/specs/2026-09-07-ticket-source-and-mobile-fixes-design.md，记录设计与验收口径。

### 任务 1：来源审计和字段归一化

**文件：** services/ticket-source-audit.js、services/tenant-schema.js、routes/tickets.js、test/ticket-source-audit.test.js

- [ ] **步骤 1：编写失败测试**

~~~js
test('外部建单保存企业、小区、反馈人、原文和请求摘要', async () => {
  const response = await postExternal({
    enterprise_name: '测试企业',
    community_name: '测试小区',
    feedback_person: 'Kitty',
    original_message: '居民原始文本',
    type: 'repair', cat: '水暖', desc: '漏水', loc: '3号楼',
    message: '{"整理消息":"整理后的文本"}',
  });
  assert.equal(response.status, 200);
  const audit = latestAudit(db);
  assert.equal(audit.feedback_person, 'Kitty');
  assert.equal(audit.original_message, '居民原始文本');
  assert.equal(audit.community_name, '测试小区');
  assert.match(audit.request_json, /测试企业/);
});
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：node --test test/ticket-source-audit.test.js
预期：测试失败，因为来源审计表和写入函数尚不存在。

- [ ] **步骤 3：实现最少代码**

新增 ticket_source_audits 表，字段包括 id、tenant_id、ticket_id、enterprise_name、community_id、community_name、feedback_person、feedback_group、original_message、source、request_json、created_at；建立 tenant_id、ticket_id 索引。实现 normalizeSourceFields 和 recordTicketSource，敏感令牌不写入审计摘要。外部建单统一读取 feedback_person/feedbackPerson/sender_name/senderName、original_message/originalMessage、feedback_group/feedbackGroup；不传原文时保持空字符串。

- [ ] **步骤 4：运行测试确认通过**

运行：node --test test/ticket-source-audit.test.js
预期：全部 PASS。

- [ ] **步骤 5：Commit**

~~~bash
git add services/ticket-source-audit.js services/tenant-schema.js routes/tickets.js test/ticket-source-audit.test.js
git commit -m "feat: audit external ticket sources"
~~~

### 任务 2：预警内容和异常工单可追溯

**文件：** services/jzm-messaging.js、routes/tickets.js、test/jzm-ticket-alerts.test.js

- [ ] **步骤 1：编写失败测试**

~~~js
test('紧急预警将字段和原文分行，且反馈人使用 sender_name', () => {
  const text = formatTicketAlert('created', {
    id: 'WX8030', cat: '电力照明',
    desc: '居民反馈停电，请安排检修。',
    created: '2026-09-07T03:40:00.000Z',
    metadata: JSON.stringify({
      feedbackPerson: 'Kitty', feedbackGroup: '居民群',
      originalMessage: '没有人解决，我要投诉',
    }),
  }, null, null);
  assert.match(text, /反馈人：Kitty/);
  assert.match(text, /原文消息：没有人解决，我要投诉/);
  assert.ok(text.indexOf('反馈原因：') < text.indexOf('原文消息：'));
});
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：node --test test/jzm-ticket-alerts.test.js
预期：新字段别名或换行断言失败。

- [ ] **步骤 3：实现最少代码**

让 notificationMetadata 接受 sender_name/senderName 作为反馈人别名，并在创建工单后立即记录来源审计。预警文本保持每个字段独立一行，反馈原因和原文各自独立一行；正文清洗 JSON 的整理消息/message/content，不发送 JSON 外壳。创建预警增加工单号、企业和小区可定位信息，且不对同一创建事件重复发送。

- [ ] **步骤 4：运行测试确认通过**

运行：node --test test/jzm-ticket-alerts.test.js test/ticket-source-audit.test.js
预期：全部 PASS。

- [ ] **步骤 5：Commit**

~~~bash
git add services/jzm-messaging.js routes/tickets.js test/jzm-ticket-alerts.test.js
git commit -m "fix: preserve ticket reporter and original message"
~~~

### 任务 3：租户范围来源查询和异常工单定位

**文件：** routes/tickets.js、test/ticket-source-audit.test.js、docs/superpowers/specs/2026-09-07-ticket-source-and-mobile-fixes-design.md

- [ ] **步骤 1：编写失败测试**

~~~js
test('来源查询只返回当前租户且按工单号可定位预警来源', async () => {
  const result = await request(server, '/api/ticket-source-audits?ticket_id=WX8030', SUPERVISOR);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.every(row => row.tenant_id === 'tenant-a'), true);
  assert.equal(result.body.data[0].ticket_id, 'WX8030');
});
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：node --test test/ticket-source-audit.test.js
预期：接口不存在或越权租户数据被返回。

- [ ] **步骤 3：实现最少代码**

新增 GET /api/ticket-source-audits，仅主管可访问，默认当前租户；支持 ticket_id、community_id、from、to 过滤，返回脱敏来源摘要。工单详情返回 sourceAuditId/source 标识。不存在的工单不产生审计记录，所有 SQL 带 tenant_id 条件。

- [ ] **步骤 4：运行测试确认通过**

运行：node --test test/ticket-source-audit.test.js test/tenant-ticket-isolation.test.js
预期：全部 PASS。

- [ ] **步骤 5：Commit**

~~~bash
git add routes/tickets.js docs/superpowers/specs/2026-09-07-ticket-source-and-mobile-fixes-design.md test/ticket-source-audit.test.js
git commit -m "feat: expose tenant-scoped ticket source audits"
~~~

### 任务 4：退回/驳回支持转单并提醒主管

**文件：** services/ticket-access.js、services/ticket-activity.js、routes/tickets.js、public/app.js、test/ticket-scope.test.js、test/jzm-ticket-alerts.test.js

- [ ] **步骤 1：编写失败测试**

~~~js
test('主管驳回后可重新指定另一名处理人，处理人退回后回到待派单', async () => {
  const rejected = await patchTicket(id, SUPERVISOR, {
    status: 'doing', worker: '李师傅', rejectReason: '需要其他工种',
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.record.worker, '李师傅');
  const returned = await patchTicket(id, WORKER, { status: 'wait', worker: '' });
  assert.equal(returned.response.status, 200);
  assert.equal(returned.body.record.status, 'wait');
});
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：node --test test/ticket-scope.test.js test/jzm-ticket-alerts.test.js
预期：主管驳回只能保留原负责人，或状态无法回到待派单。

- [ ] **步骤 3：实现最少代码**

服务端允许主管在 confirm → doing 同时修改 worker，并要求新处理人属于当前主管团队；允许主管对 doing/pending 工单直接改派，保留原工单号和活动日志。处理人退回后状态为 wait、清空稳定负责人字段并保留退回原因；主管驳回后默认回到 doing，但允许同一次请求指定新处理人。退回、驳回均提醒主管；重新派单提醒新处理人。前端去掉“不可转单”提示，退回后显示待派单选择器。

- [ ] **步骤 4：运行测试确认通过**

运行：node --test test/ticket-scope.test.js test/jzm-ticket-alerts.test.js test/ticket-activity.test.js
预期：全部 PASS。

- [ ] **步骤 5：Commit**

~~~bash
git add services/ticket-access.js services/ticket-activity.js routes/tickets.js public/app.js test/ticket-scope.test.js test/jzm-ticket-alerts.test.js
git commit -m "feat: allow reassignment after ticket return or rejection"
~~~

### 任务 5：移动端抽屉布局和现场材料显示

**文件：** public/app.js、public/styles.css、test/ticket-ui-regressions.test.js

- [ ] **步骤 1：编写失败测试**

~~~js
test('移动端工单详情使用独立现场材料容器和可换行操作组', () => {
  assert.match(source, /class="photos"/);
  assert.match(source, /class="actions"/);
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*\.actions/);
  assert.match(styles, /\.actions[\s\S]*flex-direction/);
});
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：node --test test/ticket-ui-regressions.test.js
预期：缺少移动端防遮挡规则或操作组仍横向溢出。

- [ ] **步骤 3：实现最少代码**

照片列表统一使用 photos/photo 类，不通过内联尺寸挤压标题；抽屉操作区使用 actions，移动端改为 grid，按钮宽度 100%，选择框 min-width 0，缩略图限制为容器宽度。桌面端保持现有横向布局。

- [ ] **步骤 4：运行测试确认通过**

运行：node --test test/ticket-ui-regressions.test.js
预期：全部 PASS。

- [ ] **步骤 5：Commit**

~~~bash
git add public/app.js public/styles.css test/ticket-ui-regressions.test.js
git commit -m "fix: improve mobile ticket drawer layout"
~~~

### 任务 6：回归验证

- [ ] **步骤 1：运行静态检查**

运行：git diff --check
预期：无输出，退出码 0。

- [ ] **步骤 2：运行定向测试**

运行：node --test test/ticket-source-audit.test.js test/jzm-ticket-alerts.test.js test/ticket-scope.test.js test/ticket-ui-regressions.test.js test/tenant-ticket-isolation.test.js
预期：全部 PASS。

- [ ] **步骤 3：运行完整测试**

运行：npm test
预期：退出码 0，所有测试通过。

- [ ] **步骤 4：检查变更范围**

运行：git status --short 和 git diff --stat HEAD~5..HEAD
预期：仅包含本计划列出的文件，未修改主工作树或生产数据。

