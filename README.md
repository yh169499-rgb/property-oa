# 智慧物业 OA · 工单协同管理系统

> 人员工作台升级：旧档案使用管理员专属的 `import-preview` / `import-confirm` 接口先预览后按勾选字段导入，规范化 JSON 的 SHA-256 `import_key` 保证确认幂等。Task 9 人员报告支持日期、小区筛选以及复制、打印、Word 导出。可用 `DB_PATH=/absolute/path/to/data.db node scripts/verify-workforce-migration.js` 对数据库副本执行迁移核验；脚本不改源库并打印五项结果。Task 7 签到/补卡界面本轮暂未启用。

> AI 驱动的物业工单全生命周期管理系统

**GitHub**：https://github.com/seowheqing/property-oa

---

## 系统架构

```
居民微信群
    ↓ 消息
句子秒懂 AI 智能体（意图识别 + 信息抽取）
    ↓ POST /api/tickets
┌─────────────────────────────────────────────┐
│  Node.js + Express + SQLite                  │
│  JWT鉴权 · bcrypt · 模块化路由               │
│  工单管理 · 派单 · 完结通知 · 定时提醒        │
└─────────────────────────────────────────────┘
    ↑ 管理网页                ↓ 触发事件
    主管/师傅/管家         句子秒懂 → 群内回复
```

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
| 主管 | 派单、确认、驳回、催办、管理 | 全部 |
| 维修师傅 | 完成、上传照片、搁置、退回 | 仅自己 |
| 物业管家 | 处理投诉/帮助、搁置、退回 | 仅自己 |

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
| JZMM_ACCESS_KEY_ID | 句子秒懂 AccessKeyId |
| JZMM_ACCESS_KEY_SECRET | 句子秒懂 AccessKeySecret |
| JZMM_BOT_ID | 秒懂机器人 ID |
| JZMM_EVENT_ID | 秒懂事件 ID |
| JZMM_SESSION_ID | 默认会话 ID |
| DB_PATH | 数据库文件路径；Render 生产环境固定为 `/var/data/data.db` |

### 千问 AI 润色报告

主管在“管理工作台 → 报告”生成确定性人员报告后，可以点击“AI 优化并润色”。系统会在原始统计和绩效卡之后增加一份正式的六段式解读：整体总结、工作亮点、主要问题、趋势判断、风险提醒和后续建议。复制、打印与 Word 导出都会包含 AI 润色内容。

AI 不参与工单统计、绩效计算或权限判断。服务端只向模型发送岗位、日期范围、工单数量、分类分布、处理时长、SLA 和绩效分等聚合数据，不发送姓名、手机号、人员/工单/小区 ID、地址、原始描述、图片或附件。AI 调用失败、超时或免费额度耗尽时，原始报告仍可正常查看和导出。

首期使用阿里云百炼北京地域的 OpenAI 兼容接口和 `qwen3.6-flash`。先在百炼控制台创建 API Key，并开启“免费额度用完即停”，然后在 Render 服务的 **Environment** 中配置：

```text
AI_REPORT_ENABLED=true
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_API_KEY=<仅保存在 Render 服务端环境变量中>
AI_MODEL=qwen3.6-flash
AI_TIMEOUT_MS=30000
AI_REPORT_PROMPT_VERSION=report-analysis-v1
```

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

### Supabase 免费独立存储（推荐）

如果不升级 Render 实例，可使用 Supabase Free 保存 SQLite 数据库快照。创建 Supabase 项目和私有 Storage bucket `property-oa-data` 后，在 Render 环境变量中设置：

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<仅服务端保存，不要放到前端>
SUPABASE_STORAGE_BUCKET=property-oa-data
SUPABASE_DB_OBJECT=production/data.db
SUPABASE_BACKUP_PREFIX=backups
SUPABASE_SYNC_REQUIRED=false
```

首次迁移前先下载当前数据库副本并显式确认覆盖：

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/migrate-sqlite-to-supabase.js --source=/absolute/path/to/data.db --confirm
```

迁移完成并确认远程对象存在后，将 `SUPABASE_SYNC_REQUIRED` 改为 `true`，这样生产服务找不到远程快照时会拒绝启动，避免再次悄悄创建空数据库。可通过主管账号访问 `/api/persistence/status` 查看最后同步时间和错误。

迁移后可运行 `npm run verify:supabase`，比较本地副本与远程快照的 SHA-256、表集合和各表记录数。

需要生成完整流程演示账号时，在 Render Shell 或一次性本地命令中临时设置密码（不要写入 GitHub 或长期环境变量）：

```bash
DEMO_PASSWORD='仅用于演示的临时密码' SEED_WORKFORCE_DEMO=true node scripts/seed-workforce-demo.js
```

脚本会幂等创建 `13800000011`（主管）、`13800000012`（师傅）和 `13800000013`（管家），并写入人员层级、班次模板、近 7 天排班考勤和工单演示数据。

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
- ✅ 敏感 API 需 admin 权限
- ✅ 登录限流（5次/分钟/IP）
- ✅ 滑动验证码（防机器人）
