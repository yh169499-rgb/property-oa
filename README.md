# 智慧物业 OA · 工单协同管理系统

> 人员工作台升级：旧档案使用管理员专属的 `import-preview` / `import-confirm` 接口先预览后按勾选字段导入，规范化 JSON 的 SHA-256 `import_key` 保证确认幂等。Task 9 人员报告支持日期、小区筛选以及复制、打印、Word 导出。可用 `DB_PATH=/absolute/path/to/data.db node scripts/verify-workforce-migration.js` 对数据库副本执行迁移核验；脚本不改源库并打印五项结果。Task 7 签到/补卡界面本轮暂未启用。

> AI 驱动的物业工单全生命周期管理系统

**GitHub**：https://github.com/seowheqing/property-oa

---

## 系统架构

```
唯一平台运维 platform_owner（无 tenant）
    ↓ 审核与维护，不进入企业工单
多个企业/租户（严格 tenant_id 隔离）
    ↓ 每家企业有且仅有一名主管
本企业主管
    ↓ 管理可配置人数的在职团队
维修师傅 / 物业管家 / 小区 / 工单 / 排班 / 报告
```

服务仍是 Node.js + Express + SQLite 单体部署。所有企业业务表均带 `tenant_id`，并由服务端从数据库身份注入租户范围。企业列表不返回他租户数据，跨租户详情统一返回 `404`。

---

## 快速开始

```bash
cd server
npm install
node index-new.js
# 浏览器打开 http://localhost:3001
```

首次迁移旧数据库密码（如有）：
```bash
node migrate-passwords.js
```

---

## 核心功能

### 工单管理
- 三类工单：报修（水暖/电路/电器/门窗/公共设施）、投诉、帮助/其他
- 四级优先级：紧急(2h) / 高(8h) / 普通(24h) / 低(48h)
- 工单状态：待派单 → 处理中 → 搁置中 → 待确认 → 已完成
- **搁置功能**：填原因 + 预计恢复日期，师傅释放可接新单
- **工单备注**：任何角色随时添加备注
- **工单催办**：主管对搁置工单催办，列表显示 ⚡ 标记
- 重复反馈自动合并 / 复发问题自动提升优先级

### 智能派单
- 仅向"在岗待命 + 值班时段内"的师傅派单
- 日程冲突自动检测
- 师傅状态自动推导（有工单 → 正在处理，无工单 → 在岗待命）
- 值班时间管理（主管设置，非值班时段灰色标记）

### 师傅日程（竖版飞书日历风格）
- X轴 = 师傅，Y轴 = 0:00~23:00
- 跨小区打通显示所有工单
- 非值班时段灰色背景

### 多小区管理
- 主管新建/编辑小区，设置人员访问权限
- 每个小区独立邀请码
- 师傅只能看到授权小区
- 左上角名称随小区切换

### 登录 & 安全
- 手机号 + 密码登录（bcrypt 加密）
- JWT token 鉴权（7天有效期）
- 滑动拼图验证码（本地 canvas，零网络依赖）
- 登录/注册限流（每IP每分钟5次）
- 邀请码自助注册 + 主管审核
- 密码重置

### 角色体系
| 角色 | 能力 | 可见范围 |
|------|------|---------|
| 平台运维 | 审核企业、停用/恢复企业、调整人数上限 | 平台元数据，不可访问企业工单 |
| 企业主管 | 派单、确认、驳回、催办、管理 | 仅本企业 |
| 维修师傅 | 完成、上传照片、搁置、退回 | 仅本企业且与本人相关 |
| 物业管家 | 处理投诉/帮助、搁置、退回 | 仅本企业且与本人相关 |

每企业的 `staff_limit` 默认 4，范围 1–999，限制在职维修师傅与物业管家总数，不规定两类人员比例。人员离职后删除登录账号、释放名额，历史工单保留并标记“已离职”。

### 运营看板（仅主管）
- KPI 卡片 + 趋势图 + 处理量 + 绩效表
- 待办概览（待派单数、超时工单、人员在线）

---

## 项目结构

```
server/
├── index-new.js          # 入口（模块化，默认）
├── config.js             # 配置
├── db.js                 # 数据库
├── middleware/auth.js    # JWT 鉴权
├── routes/
│   ├── auth.js           # 登录/注册/用户
│   ├── tickets.js        # 工单
│   ├── communities.js    # 小区（admin保护）
│   ├── staff.js          # 人员状态
│   └── settings.js       # 通知/SLA/月报
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── js/
│       ├── api.js        # 统一请求封装
│       └── captcha.js    # 本地验证码
└── migrate-passwords.js  # 密码迁移脚本
```

---

## API 接口

完整方法、权限、请求范围和错误码见：[API 文档](docs/API.md)。人员停用、数据持久化、附件访问和生产配置审查见：[安全审查与运行手册](docs/SECURITY-AUDIT.md)。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | /api/login | 公开 | 登录（返回JWT） |
| POST | /api/register | 公开 | 邀请码注册 |
| POST | /api/reset-password | 公开 | 重置密码 |
| GET | /api/pending-registrations | 登录 | 待审核列表 |
| POST | /api/pending-registrations/:id/approve | 登录 | 审核通过 |
| POST | /api/pending-registrations/:id/reject | 登录 | 审核拒绝 |
| GET | /api/tickets | 登录 | 工单列表 |
| POST | /api/tickets | 登录 | 创建工单 |
| PATCH | /api/tickets/:id | 登录 | 更新工单 |
| DELETE | /api/tickets/:id | **Admin** | 删除工单 |
| POST | /api/tickets/:id/photos | 登录 | 上传照片 |
| GET | /api/communities | 登录 | 小区列表 |
| POST | /api/communities | **Admin** | 创建小区 |
| PATCH | /api/communities/:id | **Admin** | 编辑小区 |
| DELETE | /api/communities/:id | **Admin** | 删除小区 |
| POST | /api/communities/:id/invite-code | **Admin** | 生成邀请码 |
| POST | /api/staff/status | 登录 | 更新状态 |
| GET | /api/staff/status | 登录 | 人员状态 |
| POST | /api/notify | 登录 | 触发通知 |
| GET | /api/report | 登录 | 生成月报 |

---

## 环境变量

| 变量 | 说明 |
|------|------|
| PORT | 端口（默认 3001） |
| JWT_SECRET | JWT 签名密钥 |
| PLATFORM_PROVISIONING_SECRET | 保护平台运维初始化命令 |
| PLATFORM_OWNER_PASSWORD | 平台运维初始凭据的运行时输入 |
| BLANK_SUPERVISOR_PASSWORD | 发财企业空白主管初始凭据的运行时输入 |
| RETAINED_TEST_PASSWORD | 保留全流程测试账号时由运维临时注入的运行时密码；只填写在受保护环境中，不写入 Git、文档或日志 |
| SUPABASE_URL | Supabase 服务端项目端点 |
| SUPABASE_SERVICE_ROLE_KEY | Supabase Storage 服务端访问凭据 |
| SUPABASE_STORAGE_BUCKET | 私有快照桶名称 |
| SUPABASE_DB_OBJECT | 生产 SQLite 快照对象名 |
| SUPABASE_BACKUP_PREFIX | 不可变备份对象的前缀 |
| SUPABASE_SYNC_REQUIRED | 远程快照不可用时的安全启动闸门 |
| JZMM_ACCESS_KEY_ID | 句子秒懂 AccessKeyId |
| JZMM_ACCESS_KEY_SECRET | 句子秒懂 AccessKeySecret |
| JZMM_BOT_ID | 秒懂机器人 ID |
| JZMM_EVENT_ID | 秒懂事件 ID |
| JZMM_SESSION_ID | 默认会话 ID |
| DB_PATH | 数据库文件路径；Render 生产环境固定为 `/var/data/data.db` |

### 千问 AI 润色报告

主管在“管理工作台 → 报告”生成确定性人员报告后，可以点击“AI 优化并润色”。系统会在原始统计和绩效卡之后增加一份正式的六段式解读：整体总结、工作亮点、主要问题、趋势判断、风险提醒和后续建议。复制、打印与 Word 导出都会包含 AI 润色内容。

AI 不参与工单统计、绩效计算或权限判断。服务端只向模型发送岗位、日期范围、工单数量、分类分布、处理时长、SLA 和绩效分等聚合数据，不发送姓名、手机号、人员/工单/小区 ID、地址、原始描述、图片或附件。AI 调用失败、超时或免费额度耗尽时，原始报告仍可正常查看和导出。

首期使用阿里云百炼北京地域的 OpenAI 兼容接口和 `qwen3.6-flash`。先在百炼控制台创建 API Key，并开启“免费额度用完即停”，然后在 Render 服务的 **Environment** 中按名称配置：

| 变量 | 用途 |
| --- | --- |
| `AI_REPORT_ENABLED` | 控制 AI 报告润色是否启用 |
| `AI_BASE_URL` | 模型服务的 OpenAI 兼容端点 |
| `AI_API_KEY` | 服务端访问凭据 |
| `AI_MODEL` | 润色使用的模型名称 |
| `AI_TIMEOUT_MS` | 单次调用超时上限 |
| `AI_REPORT_PROMPT_VERSION` | 提示词和缓存版本 |

`AI_API_KEY` 不得写入 GitHub、`render.yaml` 的 `value`、数据库或浏览器代码。相同人员、日期、小区、模型和提示词版本的报告会命中 SQLite/Supabase 持久化缓存，不重复消耗 Token；每个登录用户每分钟最多调用 5 次。

### Render 数据持久化

Render Web Service 的默认文件系统是临时的，重新部署或实例重启后会丢失运行时写入的 `data.db` 和附件。本项目的 `render.yaml` 已声明 1GB Persistent Disk，并将 `DB_PATH` 指向 `/var/data/data.db`、`UPLOAD_DIR` 指向 `/var/data/uploads`。

如果现有 Render 服务是从 Web Service 页面手动创建的，请在服务的 **Settings → Disks** 中新增磁盘：

- Name：`property-oa-data`
- Mount Path：`/var/data`
- Size：至少 `1 GB`
- Environment Variables：`DB_PATH=/var/data/data.db`
- Environment Variables：`UPLOAD_DIR=/var/data/uploads`

保存后重新部署一次。磁盘挂载前已经丢失的临时数据库无法自动恢复；挂载完成后，账号、工单、排班、考勤、模板和工单附件会跨部署保留。

### Supabase 服务端快照存储（推荐）

可使用 Supabase 私有 Storage 保存 SQLite 快照。所需服务端变量已在上表按“名称 + 用途”列出；其值只在 Render 的受保护环境中注入，不写入文档、前端、Git 或命令行。

迁移完成并确认远程对象存在后，将 `SUPABASE_SYNC_REQUIRED` 改为 `true`，这样生产服务找不到远程快照时会拒绝启动，避免再次悄悄创建空数据库。可通过主管账号访问 `/api/persistence/status` 查看最后同步时间和错误。

迁移后可运行 `npm run verify:supabase`，比较本地副本与远程快照的 SHA-256、表集合和各表记录数。

### 免费 Render 计划的一次性迁移

免费计划没有 Shell 时，可在 Render 服务的 **Environment** 中临时增加以下变量，让服务在启动前执行一次受保护的租户迁移：

```text
APPLY_TENANT_MIGRATION_ON_START=true
TENANT_MIGRATION_CONFIRM=MIGRATE-MULTI-TENANT
```

可选变量用于指定需要保留的测试主管和企业：

```text
TENANT_MIGRATION_SUPERVISOR_PHONE=13800000001
TENANT_MIGRATION_TENANT_ID=tenant-test
TENANT_MIGRATION_TENANT_NAME=全流程测试企业
TENANT_MIGRATION_STAFF_LIMIT=4
```

保存并重新部署后，日志出现“启动租户迁移完成”且服务进入 Live，即表示迁移成功。启动迁移会清理无法关联人员或小区的 `ai_report_analyses` 缓存；这些是可重新生成的 AI 缓存，不是工单报告原始数据，清理不会删除工单。确认服务正常后，应立即删除 `TENANT_MIGRATION_CONFIRM`，并将 `APPLY_TENANT_MIGRATION_ON_START` 改为 `false`；迁移已完成时即使暂时保留开关也不会重复写入。若日志仍出现 `TENANT_MIGRATION_CONFLICT`，请停止部署并先处理冲突，不要关闭生产租户校验。

### 免费 Render 的一次性平台账号初始化

平台初始化已经接入统一的受保护启动流程，不使用旧的 `STANDALONE_MANAGER_PASSWORD` 变量。需要在 Render Environment 中临时配置以下开关和密钥：

- `APPLY_PLATFORM_BOOTSTRAP_ON_START`
- `PLATFORM_BOOTSTRAP_CONFIRM`，值为 `PROVISION-PLATFORM-BOOTSTRAP`
- `PLATFORM_BOOTSTRAP_RESET_PASSWORDS_ON_START`（仅忘记初始密码时临时设为 `true`）
- `PLATFORM_PROVISIONING_SECRET`
- `PLATFORM_OWNER_PASSWORD`
- `BLANK_SUPERVISOR_PASSWORD`

保存并重新部署后，日志出现“平台账号初始化完成”即表示两个账号已写入持久化数据库。初始化只创建平台运维账号和“发财”空白企业主管，不创建小区、工单、排班、考勤、绩效或报告数据；重复执行不会覆盖已有密码。为兼容 Render 环境变量同步，只要确认口令、保护密钥和两个密码均存在，即使 `APPLY_PLATFORM_BOOTSTRAP_ON_START` 未被同步为 `true`，也会按一次性确认口令执行初始化。确认登录成功后，立即关闭 `APPLY_PLATFORM_BOOTSTRAP_ON_START` 并清空 `PLATFORM_BOOTSTRAP_CONFIRM`，保留两个密码变量供后续运维核对但不要在日志或代码中打印。

如果首次密码已写错或遗失，可在同一次初始化中临时将 `PLATFORM_BOOTSTRAP_RESET_PASSWORDS_ON_START` 设为 `true`，并更新两个密码变量；部署日志出现初始化完成后，先验证两个账号，再把该开关改回 `false`。该开关会使两个账号的旧会话立即失效，不能长期保持开启。

### 固定生产账号与多租户迁移

| 手机号 | 身份 | 数据规划 |
| --- | --- | --- |
| `13222514178` | 句子工单管理员 / `platform_owner` | 无 tenant，仅用于平台运维 |
| `13800000001` | 测试企业主管 | 保留原测试人员及全部 mock 数据 |
| `17713302589` | 发财企业主管“发财” | 空白企业，不写入 mock 数据 |

生产操作必须使用下列单一候选流程：

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

回滚条件包括快照/表记录校验失败、存在空 `tenant_id`、企业多主管、跨租户可见、历史工单断链、三个固定账号任一验证失败，以及部署后数据/认证错误。回滚步骤：验收失败时仍冻结写入，在该状态下回滚，因此不丢失部署后写入。回滚时保留故障快照，恢复迁移前 Render 备份，把同一备份上传为另一不可变 Supabase 回滚对象并校验，原子切回 `SUPABASE_DB_OBJECT`，再恢复旧版本。

提前恢复写入会要求另外设计可验证的增量重放，不作为本流程允许路径。详见 [API 文档](docs/API.md) 和 [安全审查手册](docs/SECURITY-AUDIT.md)。

---

## 技术栈

- **后端**：Node.js + Express + SQLite (sql.js) + JWT + bcrypt
- **前端**：HTML5 + CSS3 + JavaScript + ECharts
- **AI**：句子秒懂流程引擎
- **部署**：Render Web Service

---

## 安全措施

- ✅ 密码 bcrypt 哈希（10轮）
- ✅ JWT token 鉴权
- ✅ 平台域与企业域分离，企业业务服务端注入 `tenant_id`
- ✅ 登录限流（5次/分钟/IP）
- ✅ 滑动验证码（防机器人）
