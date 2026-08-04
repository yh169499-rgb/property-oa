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
