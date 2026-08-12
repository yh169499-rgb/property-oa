# 工单系统 API

接口默认前缀为 `/api`，返回 JSON。除特别标注的接口外，均要求请求头：

```http
Authorization: Bearer <JWT>
```

JWT 在每次请求时都会重新读取 `users` 当前记录；账号状态不是 `active` 时，旧令牌立即失效。

人员删除采用“停用并保留历史”：`users.status` 变为 `disabled`，对应档案变为 inactive，当前小区成员关系、排班、考勤和人员状态被清理；历史工单、工单活动和已生成报告不删除。停用账号不能重新登录，停用前签发的 JWT 在下一次请求时返回 `401`。

## 认证与人员

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/login` | 公开 | `{phone,password,rememberMe?}` 登录 |
| POST | `/register` | 公开 | `{phone,password,name,role,skill,inviteCode}`；role 只接受 `worker`/`keeper`，主管申请会被降级为维修师傅并进入待审核 |
| POST | `/reset-password` | 登录用户 | 只能修改本人密码；忘记密码需由主管处理 |
| GET | `/users` | 主管 | 用户列表及 active/disabled 状态 |
| POST | `/users` | 主管 | 创建普通账号；服务端只允许 worker/keeper |
| DELETE | `/users/:id` | 主管 | 停用账号、撤销登录权限，清理档案关联排班/考勤，保留历史工单和操作日志 |
| GET | `/pending-registrations` | 主管 | 待审核注册申请 |
| POST | `/pending-registrations/:id/approve` | 主管 | 通过申请 |
| POST | `/pending-registrations/:id/reject` | 主管 | 拒绝申请 |
| GET | `/me` | 登录用户 | 当前个人档案 |
| PATCH | `/me` | 登录用户 | 更新本人允许修改的信息 |

主管是系统最高管理角色（`主管`、`经理`、`supervisor`、`manager`、`admin`）。旧版 `lead` 账号在数据库启动迁移时转为 `主管`。

## 工单与附件

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/tickets` | 登录用户 | 支持 `community_id`、`worker` 筛选 |
| GET | `/tickets/:id` | 登录用户 | 工单详情 |
| POST | `/tickets` | 登录用户 | 创建工单；多小区必须提供 `community_id`/`communityId` |
| PATCH | `/tickets/:id` | 登录用户 | 更新状态、派单、内容或小区 |
| DELETE | `/tickets/:id` | 主管 | 删除工单 |
| POST | `/tickets/:id/photos` | 登录用户 | 上传最多 10 个图片/PDF，单个不超过 10MB；校验工单小区范围 |
| GET | `/tickets/:id/photos` | 登录用户 | 附件列表；校验工单小区范围 |

附件实际下载地址为 `/uploads/:ticketId/:filename`，必须登录且只能下载当前账号可见小区的工单附件。

## 小区、通讯录与状态

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/communities` | 登录用户 | 主管可查看/筛选全部小区；普通人员只返回本人所属小区，不接受越权 `staff_name` |
| POST/PATCH/DELETE | `/communities[/:id]` | 主管 | 小区及人员范围管理；默认小区不可删除 |
| POST | `/communities/:id/invite-code` | 主管 | 创建邀请码 |
| GET | `/communities/:id/invite-code` | 主管 | 查看邀请码；避免普通人员扩大注册范围 |
| GET | `/staff/directory` | 登录用户 | 同小区人员通讯录，返回姓名、职位、技能和手机号 |
| GET/POST | `/staff/status` | 登录用户 | 主管查看全部；普通人员只能查看/更新本人状态 |

## 日历、班次与考勤

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/calendar/day` | 登录用户 | 当日排班、请假、冲突和状态 |
| GET | `/shifts` | 登录用户 | 排班查询 |
| POST/PATCH/DELETE | `/shifts[/:id]` | 主管 | 新增、修改、删除排班 |
| GET | `/shift-templates` | 登录用户 | 班次模板 |
| POST/PATCH/DELETE | `/shift-templates[/:id]` | 主管 | 模板管理 |
| GET | `/attendance/summary` | 主管 | 历史考勤汇总 |
| POST | `/attendance/clear-all` | 主管 | 清空全部历史考勤 |
| DELETE | `/attendance/:id` | 主管 | 删除单条考勤 |

## 报告与绩效

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/dashboard/stats` | 登录用户 | 主管首页累计统计及考勤状态 |
| GET | `/reports/staff/:staff_id` | 本人/主管 | 人员、日期、小区筛选的工单和绩效报告 |
| GET | `/reports/staff/all` | 主管 | 全部人员汇总 |
| GET | `/report` | 主管（旧版全量兼容） | 兼容旧版报告接口；普通人员应使用 `/reports/staff/:staff_id` 查看本人 |
| GET | `/settings/performance` | 登录用户 | 当前绩效规则；主管可见版本历史 |
| POST | `/settings/performance/versions` | 主管 | 发布新绩效规则，服务端计算得分 |
| GET | `/reports/ai/status` | 登录用户 | AI 配置状态 |
| POST | `/reports/staff/:staff_id/ai-analysis` | 本人/主管 | AI 润色单人报告，超时不影响原始报告 |
| POST | `/reports/staff/all/ai-analysis` | 主管 | AI 润色团队汇总 |

## 系统设置与运维

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | Render 健康检查 |
| GET | `/persistence/status` | 主管 | 本地 SQLite 与 Supabase Storage 同步状态 |
| GET/POST | `/settings/reminder` | 主管 | 待派单提醒 |
| GET/POST | `/settings/sla` | 主管 | SLA 轮询与告警 |
| GET | `/sla/overdue`、`/sla/alert` | 主管 | 查询/触发 SLA 告警 |
| POST | `/notify`、`/jzm/trigger-event` | 登录用户/主管 | 外部通知；密钥只在服务端环境变量中读取 |

## 通用错误

- `401`：未登录、令牌过期或账号已停用。
- `403`：已登录但无角色/小区范围权限。
- `404`：资源不存在。
- `409`：资源冲突，例如删除仍被使用的班次模板。
- `400`：参数校验失败；错误体包含 `error` 和可选 `code`。

## 离线数据迁移命令

固定测试账号和 `MOCK-E2E` 数据通过离线命令处理，不新增公开 HTTP API：

- `npm run retained:dry-run -- --source=/absolute/path/to/data.db`：只预演，不改源文件。
- `npm run retained:apply -- --source=/absolute/path/to/data.db`：必须同时提供运行时 `RETAINED_TEST_PASSWORD`；先备份再原子写回。
- `npm run retained:verify -- --source=/absolute/path/to/data.db`：只读校验账号、组织、小区、排班、工单、活动和绩效样本。

线上操作必须先备份 Render 和 Supabase，再对候选副本迁移；验证通过后才允许替换生产文件。失败时使用执行前备份回滚，不得把本地开发 `data.db` 直接覆盖到生产。
