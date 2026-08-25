# 管理平台数据中心设计规格

日期：2026-08-24  
状态：待用户审查

## 1. 目标与范围

将现有“平台运维”用户界面统一更名为“管理平台”，内部权限角色 `platform_owner` 保持不变。管理平台新增“数据中心”，平台管理员可以按企业查看该企业的业务数据，并编辑允许的业务字段；不提供任何删除能力。

本次不改变企业端主管、维修师傅和物业管家的数据范围，也不改变企业之间的租户隔离规则。管理平台是受保护的跨企业管理入口，仅平台管理员可以访问。

## 2. 数据访问模型

### 2.1 企业选择

数据中心先加载 `/api/platform/tenants` 返回的企业列表。选择企业后，前端请求该企业可用的数据表目录及分页数据。所有请求必须携带平台管理员 JWT，服务端从 token 对应的数据库用户确认 `role='platform_owner'` 且 `tenant_id` 为空，不能信任客户端传入的企业权限。

### 2.2 数据表白名单

数据中心只允许访问固定白名单，禁止客户端传入任意表名或 SQL：

- `users`、`staff_profiles`
- `communities`、`community_permissions`、`community_memberships`
- `invite_codes`、`pending_registrations`
- `tickets`、`ticket_activity_logs`
- `shift_templates`、`shift_assignments`
- `performance_rule_versions`
- `ai_report_analyses`
- `workforce_import_batches`、`staff_lifecycle_audit`

表目录返回中文显示名、记录数、是否可编辑和允许编辑字段。不存在的表或不在白名单中的表统一返回 404/400，不回显 SQL。

### 2.3 敏感字段策略

以下字段永不返回，也不能通过编辑接口修改：

- `users.password`、`users.session_version`
- `pending_registrations.password`
- 任何 JWT、API key、服务端密钥、密码哈希或平台配置密钥

`tenant_settings` 等可能存储密钥的配置表不作为普通数据表开放；如需展示，只返回键名和“已配置/未配置”状态，不返回值。平台审计日志只通过现有审计接口查看，不允许通过数据中心修改。

## 3. 后端 API

新增平台管理员专用路由，统一挂在 `/api/platform` 下：

### 3.1 数据表目录

`GET /api/platform/tenants/:tenantId/data-tables`

返回该企业的白名单数据表、中文名称、记录数、分页上限和可编辑字段。服务端校验企业存在，但不改变企业状态。

### 3.2 分页查询

`GET /api/platform/tenants/:tenantId/data/:table`

支持：

- `page`，默认 1
- `pageSize`，默认 50，最大 200
- `search`，仅作用于该表预先声明的可搜索文本列
- `sort`、`order`，仅允许预先声明的列

返回 `{ columns, rows, page, pageSize, total }`。列定义包含字段名、中文标题、类型、是否可编辑；敏感字段已经在 SQL 投影阶段排除。

### 3.3 安全编辑

`PATCH /api/platform/tenants/:tenantId/data/:table/:id`

服务端只接受该表编辑白名单中的字段，并使用参数化 SQL。禁止修改主键、`tenant_id`、外键归属、创建时间、审计字段、认证字段和系统计算字段。编辑前读取原记录，更新后写入 `platform_audit_logs`：

```json
{
  "action": "data.update",
  "target_type": "tenant_table_row",
  "target_id": "<tenantId>/<table>/<id>",
  "before_json": "{...}",
  "after_json": "{...}"
}
```

不实现 `DELETE /api/platform/tenants/:tenantId/data/...`。即使客户端手工发送 DELETE，也返回 405/404，且不修改数据库。

## 4. 编辑字段白名单

- `users`：`name`、`phone`、`status`、`skill`（如字段存在）；禁止改角色、企业归属、密码。
- `staff_profiles`：`name`、`phone`、`position`、`skill`、`employment_status`、`join_date`、`birth_date`；禁止直接改 `tenant_id`、`user_id` 和 `manager_id`。人员层级继续使用现有组织接口校验。
- `communities`：`name`、`address`。
- `tickets`：`cat`、`desc`、`loc`、`message`、`priority`、`status`、`estimated_hours`；状态修改复用现有工单流转校验，并记录工单活动。
- `shift_templates`：模板名称、开始/结束时间、班次类型、备注等业务字段。
- `shift_assignments`：班次类型、模板、开始/结束时间、请假类型、备注；不允许改变企业和人员归属。
- `performance_rule_versions`：仅允许通过现有绩效规则校验流程更新，不允许直接篡改历史版本。

只读表包括：`ticket_activity_logs`、`ai_report_analyses`、`workforce_import_batches`、`staff_lifecycle_audit`、`community_memberships`、`community_permissions`、`invite_codes`、`pending_registrations`。如需变更这些数据，继续使用现有业务接口。

## 5. 前端管理平台

### 5.1 文案统一

以下用户可见文案统一替换：

- “平台运维登录” → “管理平台登录”
- “平台运维后台” → “管理平台后台”
- “平台运维功能” → “管理平台功能”
- “平台运维权限” → “管理平台权限”
- “平台运维操作记录” → “管理平台操作记录”

内部角色名 `platform_owner`、环境变量名和 API 路径保持兼容。

### 5.2 数据中心布局

在现有管理平台导航增加“数据中心”：

1. 企业选择器；
2. 数据表卡片/下拉列表，显示中文名称和记录数；
3. 分页表格，支持搜索、排序和横向滚动；
4. 编辑按钮仅出现在有编辑白名单的表；
5. 编辑弹窗显示字段标题、类型和校验提示；
6. 成功后刷新当前行和记录数，并提示“已写入管理审计日志”；
7. 所有表和记录为空时显示明确空状态，不使用演示数据。

删除按钮、批量删除入口和浏览器端删除调用均不提供。

## 6. 错误处理与安全要求

- 非平台管理员访问所有新接口返回 401/403，不泄露企业是否存在。
- 非法企业 ID、表名、列名、排序字段和记录 ID 使用稳定错误码。
- 所有 SQL 使用参数绑定；表名、列名只能来自服务端白名单映射，不能直接拼接客户端输入。
- 编辑操作使用乐观并发校验，记录已被更新时返回 409 并要求刷新。
- 手机号等个人信息只对平台管理员展示；日志中不写入密码或密钥。
- 编辑用户状态、人员职位或在职状态时复用账号生命周期和组织层级规则，避免产生孤立账号或跨企业人员。

## 7. 测试计划

新增或扩展以下测试：

1. 平台管理员可以读取企业目录、表目录和分页数据。
2. 租户主管、普通员工、未登录请求均不能访问数据中心接口。
3. 白名单外表、敏感字段和 DELETE 请求全部拒绝。
4. 允许编辑的人员字段可以更新，并且前后值写入平台审计日志。
5. 不能修改 `tenant_id`、角色、密码、审计字段和系统计算字段。
6. 工单、排班和人员编辑继续遵守现有租户、层级和状态校验。
7. 管理平台页面不再出现“平台运维”旧文案，数据中心无静态演示数据。

## 8. 不在本次范围

- 不提供任意 SQL 控制台。
- 不提供批量删除、数据清空、数据库结构修改和备份下载。
- 不允许平台管理员以企业用户身份登录企业端。
- 不改变企业用户端现有权限和页面流程。
