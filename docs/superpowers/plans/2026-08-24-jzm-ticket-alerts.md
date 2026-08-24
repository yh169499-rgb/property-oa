# 秒回工单预警通知实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为每个企业配置固定的秒回预警群、机器人和联系人映射，在工单创建、派单、完工及待派单提醒时向对应预警群发送统一格式消息并 @ 目标人员。

**架构：** 新增独立的秒回消息服务，统一负责读取服务端配置、调用 `/api/v2/message/send`、构造 `mentionContactIds` 并吞掉外部失败；工单路由只提交业务事件，不直接管理 HTTP 细节。企业级配置通过受保护的主管设置接口保存到租户设置表，环境变量作为全局默认值，租户配置优先。

**技术栈：** Node.js、Express、node-fetch、sql.js、Node Test Runner。

---

### 任务 1：补充失败测试，锁定消息服务和配置 API 契约

**文件：**
- 创建：`test/jzm-ticket-alerts.test.js`
- 修改：无

- [x] **步骤 1：编写失败测试**

覆盖四个行为：

```js
test('主管可保存并读取本企业秒回预警配置，普通人员不能读取密钥', async () => {
  // POST /api/settings/jzm-alert 返回 roomId、botId 和脱敏状态，不返回 msgToken/contactMap 原文
});

test('创建未派单工单向本企业预警群发送并只@主管', async () => {
  // 注入 fake sender，断言 imRoomId、imBotId、messageType=7、mentionContactIds=[managerContactId]
});

test('创建已派单或后续派单工单只@处理人', async () => {
  // 断言消息包含工单字段，mentionContactIds 使用被派单人员映射
});

test('完工和待派单提醒使用对应模板', async () => {
  // 完工包含“工单完结提醒”，待派单包含“当前还有 N 张工单待派单”
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`node --test test/jzm-ticket-alerts.test.js`

预期：FAIL，提示配置接口、消息发送器或工单事件钩子尚未实现。

### 任务 2：实现服务端秒回消息服务

**文件：**
- 创建：`services/jzm-messaging.js`
- 修改：`config.js`
- 修改：`.env.example`

- [x] **步骤 1：实现最小服务**

服务提供：

```js
getTenantAlertConfig(db, tenantId)
sendTicketAlert({ db, tenantId, kind, ticket, actor, assignee })
sendWaitingTicketsAlert({ db, tenantId, count })
```

使用秒回接口：

```js
POST ${JZMM_MSG_BASE_URL}/api/v2/message/send?token=${JZMM_MSG_TOKEN}
{
  imBotId,
  imRoomId: roomId,
  messageType: 7,
  payload: { text, mentionContactIds }
}
```

联系人解析顺序：企业设置中的 `contact_map`，再回退到服务端 `JZMM_CONTACT_MAP_JSON`；未找到联系人时不伪造 @，消息仍发送并记录 warning。

消息模板固定为：

- 创建：`————紧急消息提醒————`，包含时段、反馈人、反馈群、反馈事件、反馈原因、原文消息和 `———！！请注意留意！！———`。
- 完工：`————工单完结提醒————`，包含时段、工单号、反馈事件、处理人、原文消息和 `———！！已处理完毕！！———`。
- 待派单：`主管待派单` + `当前还有 N 张工单待派单，请尽快处理。`。

外部接口失败只记录日志并返回 `{ success: false }`，不能回滚工单事务。

- [x] **步骤 2：运行消息服务测试**

运行：`node --test test/jzm-ticket-alerts.test.js`

预期：服务层相关断言通过，路由钩子相关断言仍失败。

### 任务 3：增加企业预警配置 API

**文件：**
- 创建或修改：`services/tenant-alert-config.js`
- 修改：`routes/settings.js`
- 修改：`docs/API.md`

- [x] **步骤 1：实现接口**

新增：

```http
GET  /api/settings/jzm-alert
POST /api/settings/jzm-alert
```

主管只能操作自己的企业配置。请求支持：

```json
{
  "roomId": "固定群ID",
  "imBotId": "固定机器人ID",
  "managerContactId": "主管联系人ID",
  "contactMap": {
    "张师傅": "师傅联系人ID",
    "13800000002": "师傅联系人ID"
  }
}
```

`JZMM_MSG_TOKEN` 只允许从 Render 环境变量读取，接口永不接受或返回 Token。响应只返回 `roomId`、`imBotId`、是否配置 Token、联系人数量和更新时间。

- [x] **步骤 2：运行配置测试**

运行：`node --test test/jzm-ticket-alerts.test.js`

预期：配置 API、权限和脱敏断言通过。

### 任务 4：接入工单创建、派单和完工事件

**文件：**
- 修改：`routes/tickets.js`
- 修改：`services/ticket-activity.js`（如需复用动作事件）

- [x] **步骤 1：创建成功后触发创建提醒**

工单持久化成功后异步调用 `sendTicketAlert`：未派单使用主管联系人；已派单使用处理人联系人。重复合并工单不重复发送创建提醒，只增加反馈计数。

- [x] **步骤 2：派单成功后触发派单提醒**

在 PATCH 的 `worker` 从空变为有效人员，或变更为另一有效人员时发送派单提醒并 @ 当前处理人。

- [x] **步骤 3：完成成功后触发完工提醒**

在状态变为 `done` 且数据库更新成功后发送完工模板；保留原有工单响应，不等待第三方成功。

- [x] **步骤 4：运行路由测试**

运行：`node --test test/jzm-ticket-alerts.test.js test/ticket-scope.test.js test/ticket-community.test.js`

预期：全部通过，既有工单权限和小区隔离不变。

### 任务 5：接入主管待派单提醒和文档

**文件：**
- 修改：`routes/settings.js`
- 修改：`docs/API.md`
- 修改：`.env.example`

- [x] **步骤 1：改造待派单提醒**

`/api/reminder/trigger` 和定时提醒按每个企业分别统计 `status = 'wait'`，发送到该企业固定预警群并 @ 主管；没有配置秒回时保留当前接口返回但记录未配置原因。

- [x] **步骤 2：补充 API 文档与配置说明**

记录配置接口、消息触发时机、请求字段、失败语义、Render 环境变量和联系人映射示例；禁止写入真实 Token。

- [ ] **步骤 3：运行完整验证**

运行：`npm test`

预期：全部测试通过，新增测试至少覆盖创建、派单、完工、待派单、租户隔离和脱敏。

### 任务 6：提交变更

**文件：**
- 任务 2-5 中列出的全部文件

- [x] **步骤 1：检查敏感信息**

运行：`rg -n "JZMM_MSG_TOKEN\\s*=|mentionContactIds.*[A-Za-z0-9]{16,}" . --glob '!node_modules/**'`

预期：只出现环境变量名、测试占位符或文档示例，不出现真实 Token。

- [x] **步骤 2：提交**

```bash
git add services/jzm-messaging.js services/tenant-alert-config.js routes/tickets.js routes/settings.js config.js .env.example docs/API.md test/jzm-ticket-alerts.test.js
git commit -m "feat: add tenant ticket alert notifications"
```
