# 工单来源审计、移动端详情与可转单设计

## 背景

线上曾出现预警消息显示“3号楼502·电力照明”，但在当前工单列表找不到；同时预警缺少原文、反馈人来自错误字段，手机端详情的现场照片会遮挡标题且操作按钮溢出。退回和驳回也需要支持再次转派，并提醒主管。

## 目标

1. 每次外部建单都能通过租户、企业、小区、工单号和来源请求摘要反查。
2. 接口兼容 feedback_person、feedbackPerson、sender_name、senderName，以及 original_message、originalMessage。
3. 预警按“@行 → 标题 → 字段行 → 反馈原因 → 原文消息 → 收尾行”输出，不泄露 JSON 外壳。
4. 退回/驳回不锁定原处理人；主管可重新指定直属在职人员，退回/驳回提醒主管，改派提醒新处理人。
5. 手机端照片区和操作区独立布局，不遮挡、不横向滚动。
6. 来源查询严格限定当前租户，敏感 token 不进入审计记录。

## 数据设计

新增 ticket_source_audits：

- id：自增主键
- tenant_id：企业租户
- ticket_id：工单号
- enterprise_name：建单时企业名称
- community_id、community_name：服务端解析后的小区
- feedback_person、feedback_group、original_message：归一化来源字段
- source：external 或 supervisor
- request_json：脱敏后的请求摘要
- created_at：接收时间

索引：

- (tenant_id, ticket_id)
- (tenant_id, created_at)

工单详情可返回 sourceAuditId 和 source，列表不返回原始请求全文。

## 接口设计

- POST /api/tickets/external：维持现有成功响应 success=true；新增字段别名兼容。
- GET /api/ticket-source-audits：主管可访问，默认当前企业；支持 ticket_id、community_id、from、to。
- 来源查询返回字段均为脱敏摘要；跨企业工单返回空结果而非越权错误。

## 预警设计

创建预警使用来源元数据：

~~~text
@主管
————紧急消息提醒————
时段：...
反馈人：...
反馈群：...
反馈事件：...
反馈原因：...
原文消息：...
工单号：...
企业：...
小区：...
———！！请注意留意！！———
~~~

反馈人或原文为空时不输出对应行。反馈原因来自整理后的 desc/message；原文只来自原文字段，不自动把整理消息当原文。

## 状态和转单

- 处理人退回：doing → wait，清空稳定负责人字段，保留退回原因和活动日志。
- 主管驳回：confirm → doing；可同时传入新 worker，服务端验证其属于当前主管直属在职团队。
- 主管对 doing/pending 工单可改派；每次改派写 assign 活动并提醒新处理人。
- 退回和驳回始终向当前企业主管发送提醒。
- 工单号不变，所有活动时间线连续保留。

## 移动端设计

- 现场材料使用 block 容器和 flex-wrap，缩略图 max-width: 100%。
- 操作区在 480px 以下改为单列 grid，按钮和 select 宽度 100%，避免六个按钮挤在一行。
- 桌面端保留当前横向紧凑布局。
- 不改变照片鉴权加载和 Blob URL 释放逻辑。

## 验收标准

- 预警能显示传入 sender_name 和 original_message，缺失字段不显示空标签。
- 截图中的 WX8030 类异常可通过来源接口按工单号和小区定位请求。
- 两个租户互查来源返回空，token 不出现在响应。
- 退回后工单回到待派单；主管可改派另一名直属人员；两类提醒均发送。
- 手机宽度 375px 时，照片标题、缩略图和操作按钮均不遮挡、不横向溢出。

