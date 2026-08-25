# 工单系统 API

所有接口默认使用 `/api` 前缀并返回 JSON。本系统分为平台域和企业域：全平台有且仅有一个 `platform_owner`（唯一平台运维），可管理多个企业/租户；每家企业有且仅有一名主管。主管只能管理本企业，平台运维不能进入企业工单、小区、排班或报告。

## 身份与租户范围

除公开申请和登录接口外，请求必须携带 `Authorization: Bearer <JWT>`。JWT 只用于定位会话；服务端每次请求均从数据库恢复用户当前的角色、状态、`tenant_id` 和 `session_version`，不信任 JWT 或请求体中自报的权限。

所有企业接口都由服务端注入 `tenant_id`：

- 客户端不得选择或改写 `tenant_id`；写入数据时使用已恢复身份的租户。
- 列表查询不返回其他租户的任何记录。
- 跨租户详情读取与“不存在”使用统一 `404`，避免泄露资源是否存在。
- 跨租户写入返回 `403`，且不会将目标记录内容放入错误响应。
- 租户状态为 `disabled`、账号被删除或 `session_version` 变化时，旧会话立即返回 `401`。

每个企业的 `staff_limit` 独立配置，默认 4，只接受 1–999 的整数，仅计算在职的维修师傅和物业管家。人员离职会删除登录账号、释放名额，但历史工单和流转记录保留并标记“已离职”。

## 企业端接口概览

| 方法 | 路径 | 角色 | 租户规则 |
| --- | --- | --- | --- |
| POST | `/api/login` | 公开 | 只签发企业用户会话，不接受 `platform_owner` |
| GET/PATCH | `/api/me` | 企业用户 | 只读写本人 |
| GET/POST/DELETE | `/api/users[/:id]` | 本企业主管 | 仅本企业普通人员；客户端不能传 `staffLimit`/`staff_limit` |
| GET/POST | `/api/pending-registrations[/:id/approve|reject]` | 本企业主管 | 仅本企业申请，容量不足返回 `409` |
| GET/POST/PATCH/DELETE | `/api/tickets[/:id]` | 企业用户 | 首先按租户过滤，再应用本人/小区权限 |
| POST | `/api/tickets/external` | `X-JZM-Ingest-Token` | 按企业名称解析租户，系统生成工单并触发企业预警 |
| GET/POST/PATCH/DELETE | `/api/communities[/:id]` | 企业用户/主管 | 仅本企业小区和邀请码 |
| GET/POST/PATCH/DELETE | `/api/shifts`、`/api/shift-templates` | 企业用户/主管 | 仅本企业人员和模板 |
| GET/POST | `/api/reports/*`、`/api/settings/*` | 企业用户/主管 | 统计、缓存、绩效规则和设置均按租户隔离 |

### 秒回统一预警群

每个企业使用一个固定的秒回预警群。发送 Token 只从 Render 的
`JZMM_MSG_TOKEN` 服务端环境变量读取；群 `roomId`、机器人 `imBotId`、主管
`contactId` 和人员联系人映射由本企业主管在系统设置中保存。接口不会在响应中返回
Token 或联系人映射。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/settings/jzm-alert` | 主管 | 查看当前企业群、机器人和联系人配置状态（不返回密钥） |
| POST | `/api/settings/jzm-alert` | 主管 | 保存 `roomId`、`imBotId`、`managerContactId`、`contactMap` |

`POST` 请求示例：

```json
{
  "roomId": "企业固定预警群 roomId",
  "imBotId": "企业固定机器人 imBotId",
  "managerContactId": "主管 contactId",
  "contactMap": {
    "张师傅": "维修师傅 contactId",
    "13800000002": "维修师傅 contactId"
  }
}
```

成功创建工单后，系统向该群发送“紧急消息提醒”：未派单时 `@主管`，已派单时
`@处理人`。工单首次完结时，系统向当前企业预警群发送“工单完结提醒”，消息包含
工单号、事件、地点、处理人和完成时间；此时 `mention` 为空，不 `@`任何人。重复保存
`done` 状态不会重复发送完结提醒。
定时提醒和 `POST /api/reminder/trigger` 只统计当前企业待派单工单，并发送
`主管待派单`提醒并 `@主管`。发送失败只记录服务端告警，不影响工单原始写入。
首次派单或改派给其他处理人后，系统向同一预警群发送“您有新的派单，请及时处理”，
并通过企业联系人映射原生 `@`当前处理人；处理人未变时不重复发送。

外部秒回发送接口使用 `POST https://ae-bg.ddregion.com/hub-api/api/v2/message/send?token=...`，消息体为
`{ imBotId, imRoomId, messageType: 7, payload: { text, mention } }`，其中 `mention`
为需要原生 `@` 的联系人 wxid 数组。

## 外部系统按企业名称建单

秒回或其他外部系统不需要为每家企业伪造 Bearer 登录会话。使用服务端环境变量
`JZMM_INGEST_TOKEN` 配置的独立入站令牌，调用 `POST /api/tickets/external`，并在
请求体中传入企业名称。服务端会按企业名称（忽略首尾空格、大小写）精确解析 active
企业，找到该企业主管后在该企业租户内创建工单；不会接受客户端传入 `tenant_id`。

请求头：

```http
X-JZM-Ingest-Token: <Render 中配置的 JZMM_INGEST_TOKEN>
Content-Type: application/json
```

请求示例（首次建单时也可以把该企业的秒回 ID 一并交给系统保存）：

```json
{
  "enterprise_name": "企业名称",
  "roomid": "企业固定预警群 roomId",
  "imbotid": "企业固定机器人 imBotId",
  "contactid": "主管 contactId",
  "contact_map": { "张师傅": "维修师傅 contactId" },
  "type": "repair",
  "cat": "水暖",
  "desc": "3号楼2单元漏水",
  "loc": "3号楼2单元",
  "message": "请尽快处理",
  "community_name": "小区名称",
  "feedback_person": "闫亚多",
  "feedback_group": "工单冠军居民群",
  "original_message": "居民原始消息"
}
```

`enterprise_name` 也兼容 `enterpriseName`、`company_name`、`tenant_name`；秒回 ID
兼容 `roomId`/`room_id`、`imBotId`/`im_bot_id`、`contactId`/`contact_id`。携带任意
一个秒回配置字段时，三项群/机器人/主管联系人必须同时提供，系统会按该企业保存，之后
创建、派单、完工和待派单提醒均自动使用该企业自己的 room、机器人和联系人映射。

外部接口只允许系统生成工单号、当前时间、`wait` 状态、`normal` 优先级和未派单状态；
请求中即使带有 `id`、`status`、`priority`、`worker` 或 `created` 也不会覆盖这些内部字段。
建单或合并成功时只返回 `200 {"success": true}`；工单详情、工单号和归属信息保存在系统
内部，不作为外部接口响应返回。失败时仍返回 `error` 与稳定的 `code` 方便调用方处理。
小区仍按企业范围校验：单小区可省略，多小区必须传 `community_id`、`communityId` 或
`community_name`。未知企业返回 `404 ENTERPRISE_NOT_FOUND`，同名企业返回
`409 ENTERPRISE_AMBIGUOUS`，停用企业返回 `403 ENTERPRISE_DISABLED`，令牌错误返回
`401 INVALID_INTEGRATION_TOKEN`。

## 平台读接口

读取接口不接受请求体。查询参数均为可选且必须通过服务端白名单校验；响应不包含任何凭据或密钥。

### 企业数据中心

管理平台的数据中心只允许无租户的 `platform_owner` 访问，用于按企业查看和修正业务数据。
内部角色名和 `/api/platform` 路径保持兼容，页面名称为“管理平台”。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/platform/tenants/:tenantId/data-tables` | 返回该企业允许查看的数据表目录、字段元数据、记录数和是否可编辑 |
| GET | `/api/platform/tenants/:tenantId/data/:table` | 按白名单表分页查询；支持 `page`、`pageSize`、`search` |
| PATCH | `/api/platform/tenants/:tenantId/data/:table/:id` | 修改白名单中的业务字段，写入 `platform_audit_logs` |
| DELETE | `/api/platform/tenants/:tenantId/data/:table/:id` | 永久返回 `405 PLATFORM_DATA_DELETE_FORBIDDEN`，平台数据中心不提供删除 |

允许查看的表包括账号、人员档案、小区、工单、排班、班次模板、考勤记录、工单流转、绩效规则、
AI 报告和人员生命周期日志。`tenant_settings`、平台审计日志以及任何密码、密码哈希、JWT、
API Key、Session 信息均不通过该目录暴露。所有查询强制追加目标 `tenant_id`，未知表返回
`404 PLATFORM_DATA_TABLE_NOT_FOUND`，跨租户记录统一按不存在处理。

可编辑范围仅限业务资料：人员姓名、手机号、职位（不能填写主管/平台权限字样）、在职状态、
入职日期、出生年月；小区名称和地址；工单描述、分类、位置、留言、优先级、状态和预计工时；
班次模板与排班字段。账号/人员资料修改会同步双方资料并增加会话版本，手机号冲突返回
`409 PHONE_CONFLICT`。工单状态修改复用企业端状态流转校验并记录工单活动；禁止通过数据中心
修改角色、密码、租户归属、主管关系、派单人或删除历史记录。

## 外部建单接口

企业内部前端调用 `/api/tickets` 时仍需使用企业用户的 Bearer 会话；企业归属由登录
身份确定，不能由请求体伪造。外部系统请使用上面的 `/api/tickets/external`，由服务端
根据企业名称解析归属。

### POST `/api/tickets`

请求示例：

```json
{
  "type": "repair",
  "cat": "水暖",
  "desc": "3号楼2单元漏水",
  "loc": "3号楼2单元",
  "message": "请尽快处理",
  "community_name": "小区名称"
}
```

支持的 `type` 为 `repair`（报修）、`complaint`（投诉）和 `help`（帮助）。为兼容秒回模型
偶尔返回的别名，`/api/tickets/external` 也接受 `complain`，并在服务端归一化保存为
`complaint`。服务端会
校验小区是否属于当前企业，并生成工单号和 `wait` 初始状态。主管也可以在同一请求中
传入有效的 `worker`，此时工单初始为 `doing` 并直接通知该处理人；普通人员提交的
`worker`、状态、优先级和创建时间会被忽略或强制覆盖。

建单成功后，系统异步向该企业固定秒回预警群发送消息：未派单 `@主管`，已派单
`@处理人`。秒回发送失败不会回滚工单，接口仍返回原始工单记录。

错误：`400 COMMUNITY_REQUIRED`（多小区缺少小区）、`400 COMMUNITY_NOT_FOUND`
（未知小区）、`400 COMMUNITY_AMBIGUOUS`（同名小区不唯一）、`401`（会话无效）、
`403`（无权访问小区）或 `400 INVALID_TICKET_TYPE`（类型不支持）。

### GET /api/platform/overview

- 角色：仅 `platform_owner`。
- 请求字段：无 body；无可选 query，未识别的 query 字段不得改变统计口径。
- 成功响应：`200`，返回企业总数、待审核数、启用/停用企业数、账号/工单总量和持久化状态；只含平台聚合值，不返回企业工单明细。
- `400`：query 格式不合法或包含不允许的多值参数。
- `401`：平台会话缺失、过期或 `session_version` 失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：路由不存在；该聚合端点正常不会因某个企业不存在而返回。
- `409`：正在执行与聚合快照不兼容的维护切换时可返回；普通读取正常不产生。

### GET /api/platform/applications

- 角色：仅 `platform_owner`。
- 请求字段：无 body；可选 query 为 `status`、`page`、`pageSize`，分别用于状态筛选和分页。
- 成功响应：`200`，返回申请列表和分页元数据；列表只含申请 ID、时间、企业名称、主管名称/手机号、状态和审核结果，不包含密码或哈希。
- `400`：`status` 不在允许集合内，或 `page`/`pageSize` 不是允许范围内的整数。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：路由不存在；筛选结果为空时仍返回 `200` 和空列表。
- `409`：申请集合正在执行不可兼容的迁移或维护切换；普通分页读取正常不产生。

### GET /api/platform/tenants

- 角色：仅 `platform_owner`。
- 请求字段：无 body；可选 query 为 `status`、`search`、`page`、`pageSize`，用于企业状态、名称/主管搜索和分页。
- 成功响应：`200`，返回分页企业列表；每项包含企业名称、主管名称/手机号、状态、创建时间、主管最后登录、`active_staff_count`、`staff_limit`、小区数和工单数，不返回工单内容。
- `400`：筛选值、搜索长度或分页参数不合法。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：路由不存在；搜索无匹配企业时仍返回 `200` 和空列表。
- `409`：租户集合正在完成不可兼容的迁移或快照切换；普通列表读取正常不产生。

### GET /api/platform/audit-logs

- 角色：仅 `platform_owner`。
- 请求字段：无 body；可选 query 为 `action`、`tenantId`、`page`、`pageSize`，用于动作/目标企业筛选和分页。
- 成功响应：`200`，返回分页审计日志；只含操作人、动作、目标 ID、时间和非敏感变更摘要。
- `400`：动作筛选、`tenantId` 格式或分页参数不合法。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：路由不存在；目标企业无日志时仍返回 `200` 和空列表，不借此枚举企业。
- `409`：审计索引正在执行不可兼容的迁移/重建；普通分页读取正常不产生。

## 平台写接口

下列错误响应统一使用 `{ error, code? }`；响应永远不回显密码、哈希、JWT 或密钥。

### POST /api/enterprise-applications

- 角色：公开，使用独立限流；不需要任何企业或平台会话。
- 请求字段：`enterpriseName`（必填）、`supervisorName`（必填）、`phone`（必填）、`password`（必填）。不接受客户端指定 `tenant_id`、角色或 `staffLimit`。
- 成功响应：`201`，`{ success, application: { id, status } }`；状态为 `pending`，不自动登录。
- `400`：字段缺失、格式不合法或企业名称超限。
- `401`：此公开接口正常不产生；若以后增加前置认证闸门，代表认证失败。
- `403`：此公开接口正常不产生；安全策略明确拒绝请求时使用。
- `404`：路由或引用的公开资源不存在；本方法不暴露企业是否存在。
- `409`：手机号已被正式账号或待处理申请占用。

### POST /api/platform/login

- 角色：公开的平台独立登录入口，仅允许 `platform_owner`；企业账号不得从此入口登录。
- 请求字段：`phone`、`password`，均必填。
- 成功响应：`200`，`{ success, token, user: { id, phone, name, role } }`；`user` 不带企业租户。
- `400`：字段缺失或手机号格式不合法。
- `401`：凭据错误或会话签发失败。
- `403`：手机号对应企业角色或平台账号不可用。
- `404`：登录故意不区分“账号不存在”，对外应统一为 `401`；该状态仅保留给路由不存在。
- `409`：此无状态写入方法正常不产生；并发会话策略冲突时使用。

### POST /api/platform/applications/:id/approve

- 角色：仅 `platform_owner`。
- 请求字段：可选 `staffLimit`，省略时默认 4，必须是 1–999 的整数。
- 成功响应：`200`，返回新企业 `tenantId`、唯一主管 `userId`、`staffLimit` 和审核状态；密码哈希从申请记录转入账号后即从申请中清除。
- `400`：`staffLimit` 不是 1–999 的整数，`code` 为 `INVALID_STAFF_LIMIT`。
- `401`：平台会话缺失、过期或 `session_version` 失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：申请 `id` 不存在。
- `409`：申请已被处理、手机号已占用，或无法满足每企业唯一主管约束。

### POST /api/platform/applications/:id/reject

- 角色：仅 `platform_owner`。
- 请求字段：`reason`（必填，非空审核原因）。
- 成功响应：`200`，返回申请 `id`、`rejected` 状态和审核时间；同一事务内清除申请密码哈希。
- `400`：`reason` 缺失、为空或超长。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：申请 `id` 不存在。
- `409`：申请已通过或已拒绝，不得重复审核。

### POST /api/platform/tenants/:id/disable

- 角色：仅 `platform_owner`。
- 请求字段：无必填业务字段；客户端不得传入账号、密码或 `tenant_id` 变更。
- 成功响应：`200`，返回企业 `id`、`disabled` 状态和更新时间；租户内用户 `session_version` 同步递增，旧会话立即失效。
- `400`：路径 `id` 或请求体格式不合法。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：企业 `id` 不存在。
- `409`：企业已停用或正在被另一维护事务更新。

### POST /api/platform/tenants/:id/restore

- 角色：仅 `platform_owner`。
- 请求字段：无必填业务字段。
- 成功响应：`200`，返回企业 `id`、`active` 状态和更新时间；数据原样保留，用户需使用当前凭据重新登录。
- `400`：路径 `id` 或请求体格式不合法。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：企业 `id` 不存在。
- `409`：企业已处于启用状态或状态更新冲突。

### POST /api/platform/tenants/:id/reset-supervisor-password

- 角色：仅 `platform_owner`。
- 请求字段：`newPassword`（必填）；值只在当次 TLS 请求中使用，不进入审计摘要或响应。
- 成功响应：`200`，只返回 `success`、企业 `id` 和主管账号 `id`；新值以 bcrypt 哈希存储，并递增主管 `session_version`。
- `400`：`newPassword` 缺失或不符合密码策略。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：企业或其唯一主管账号不存在。
- `409`：企业状态不允许重置，或主管归属约束冲突。

### PATCH /api/platform/tenants/:id

- 角色：仅 `platform_owner`。
- 请求字段：`name`（可选，2–80 字符）、`staffLimit`（可选，1–999 的整数），可单独或同时修改；至少提供一项。
- 成功响应：`200`，`{ success, tenant }`；`tenant` 包含最新 `name`、`staff_limit`、`active_staff_count` 和状态。审计摘要只记录变更字段的前后值。
- `400`：未提供可修改字段、名称不合法，或 `staffLimit` 不是 1–999 的整数。
- `401`：平台会话缺失、过期或失效。
- `403`：已登录但不是 `platform_owner`。
- `404`：企业 `id` 不存在。
- `409`：新上限低于当前在职普通人员数，`code` 为 `STAFF_LIMIT_BELOW_ACTIVE_COUNT`；整个更新不写入。

## 固定生产账号归属

| 手机号 | 角色/名称 | 数据归属 |
| --- | --- | --- |
| `13222514178` | `platform_owner` / 句子工单管理员 | `tenant_id` 为空，不属于任何租户，只登录平台运维入口 |
| `13800000001` | 测试企业唯一主管 | 保留既有模拟数据、测试人员和全部历史业务数据 |
| `17713302589` | 发财企业唯一主管 / 发财 | 空白企业，无 mock 数据，不创建小区、人员、工单、排班、绩效或报告 |

## 生产迁移与回滚

必须按以下顺序执行，不得将本地开发库或旧远端快照直接作为候选：

1. 停止写入，并在整个迁移、部署和验收期间继续冻结。
2. 冻结写入后的 Render `/var/data/data.db` 是唯一权威候选；先将它复制到 `/absolute/path/multi-tenant-candidate.db`，后续不再更换候选路径。
3. 下载并校验 Supabase 快照，Supabase 只作对照和备份。比较 SHA-256、表集合和记录数；任一不一致都必须中止，先同步或排障，不得迁移旧远端快照。
4. 保存迁移前备份及其校验和、表集合和记录数摘要。
5. 只对候选副本执行 `npm run tenant:dry-run -- --source=/absolute/path/multi-tenant-candidate.db`。
6. 仍只对同一候选副本执行 `npm run tenant:apply -- --confirm=MIGRATE-MULTI-TENANT --source=/absolute/path/multi-tenant-candidate.db`。
7. 仍只对同一候选副本执行 `npm run verify:multi-tenant -- --source=/absolute/path/multi-tenant-candidate.db`。
8. 验收候选库的租户归属、唯一主管、人数上限、历史引用和空白企业。
9. 上传新快照为新的不可变 Supabase 对象；校验该对象后，再原子切换 `SUPABASE_DB_OBJECT`，不直接覆盖旧快照。
10. 部署新版本，但仍不对外恢复写入。
11. 保持停止写入，验证三个固定账号登录、跨租户隔离、完整性、持久化；全部验收通过后才恢复写入。
12. 保留旧快照、Render 原备份和候选库备份，直到观察期结束。

回滚条件：快照/表记录校验失败、存在空 `tenant_id`、企业多主管、跨租户可见、历史工单断链、三个固定账号任一验证失败，以及部署后数据/认证错误。回滚步骤：验收失败时仍冻结写入，在该状态下回滚，因此不丢失部署后写入。回滚时保留故障快照，恢复迁移前 Render 备份，把同一备份上传为另一不可变 Supabase 回滚对象并校验，原子切回 `SUPABASE_DB_OBJECT`，再恢复旧版本。

提前恢复写入会要求另外设计可验证的增量重放，不作为本流程允许路径。

## 环境变量名称与用途

下表只列名称和用途；所有值都在 Render 或受控运维环境中注入，不得写入文档、命令参数、Git 或日志。

| 名称 | 用途 |
| --- | --- |
| `PLATFORM_PROVISIONING_SECRET` | 保护唯一平台运维初始化命令 |
| `PLATFORM_OWNER_PASSWORD` | 平台运维初始登录凭据的运行时输入 |
| `BLANK_SUPERVISOR_PASSWORD` | 发财企业空白主管的初始凭据输入 |
| `JWT_SECRET` | 签发和校验 JWT |
| `SUPABASE_URL` | Supabase 服务端项目端点 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Storage 服务端访问凭据 |
| `SUPABASE_STORAGE_BUCKET` | 私有快照桶名称 |
| `SUPABASE_DB_OBJECT` | 当前 SQLite 快照对象名 |
| `SUPABASE_BACKUP_PREFIX` | 不可变备份对象前缀 |
| `SUPABASE_SYNC_REQUIRED` | 控制远端快照失败时是否拒绝启动 |
