# 人员权限、数据安全与全流程演示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 逐任务实现此计划。步骤使用复选框跟踪进度。

**目标：** 将主管设为唯一全局管理角色，确保普通人员只能注册申请并经主管审核，删除人员时同步撤销登录权限和人员档案；补齐所有业务接口鉴权、数据持久化检查、可重复演示数据和 API 文档。

**架构：** 认证层统一校验 JWT、账号状态和角色；路由层默认要求登录，敏感写入仅允许主管。人员删除采用事务清理账号、档案、组织/小区关系和排班考勤关联，工单历史保留但解除已删除人员的派单关系。演示数据仅由显式环境变量开启，并与生产数据隔离。

**技术栈：** Express、JWT、bcryptjs、sql.js/SQLite、Supabase Storage 快照、Node 内置测试。

---

### 任务 1：认证与角色边界

**文件：** `services/roles.js`、`middleware/auth.js`、`routes/auth.js`、`workforce-schema.js`、相关认证测试。

- [x] 为 `users` 增加可迁移的 `status`/禁用字段，JWT 鉴权时回查账号状态。
- [x] 将主管全局管理权限集中到 `isGlobalManagerRole`，普通 `lead` 不再获得系统管理权限。
- [x] 注册申请强制只能提交普通岗位，主管账号不允许公开注册；审核前保持 pending。
- [x] 重置密码必须登录并只能修改本人或由主管处理，禁止仅凭手机号接管账号。
- [x] 编写未登录、普通员工、禁用账号、普通注册申请和主管审核的失败测试。

### 任务 2：人员删除与级联安全

**文件：** `routes/auth.js`、`routes/profiles.js`、`services/workforce-migration.js`、`workforce-schema.js`、人员 API 测试。

- [x] 删除账号时同步停用 `staff_profiles`，清理小区关系、排班、考勤和状态记录。
- [x] 保留历史工单与活动日志，停用人员不再进入 active 数据范围；禁止删除主管本人或最后一个主管。
- [x] 删除完成后旧 JWT 立即失效，重复删除返回明确错误。
- [x] 补充主管可删、普通人员不可删、删除后登录失败和历史数据保留测试。

### 任务 3：全路由鉴权与数据范围

**文件：** `server-app.js`、`routes/tickets.js`、`routes/communities.js`、`routes/staff.js`、`routes/settings.js`、`routes/shifts.js`、`routes/profiles.js`、`routes/workforce-reports.js`、`routes/attendance.js`、测试文件。

- [x] 所有工单、附件、状态、报告、提醒、SLA、通知和小区敏感接口默认 `requireAuth`。
- [x] 主管写入接口使用统一管理中间件；普通人员只能访问本人或同小区授权数据。
- [x] 小区列表、邀请码、人员手机号和报告按账号/小区范围返回，不再公开泄露。
- [x] 对输入字段、日期和上传文件类型/大小增加白名单校验，并保护附件静态下载。
- [x] 建立接口矩阵测试：未登录 401、普通人员 403、主管成功、跨小区 403。

### 任务 4：持久化与一致性审计

**文件：** `db.js`、`services/supabase-storage.js`、`services/persistence-status.js`、`server-app.js`、持久化测试与迁移脚本。

- [x] 检查启动恢复、写入队列、失败重试和 Supabase 快照版本；通过 `SUPABASE_SYNC_REQUIRED` 控制是否允许本地降级启动。
- [x] 账号、人员、工单、排班、考勤、模板、绩效、报告缓存写入均等待或排队 `saveDB()`。
- [x] 使用临时数据库种子和 `verify:e2e` 执行表级记录恢复/连通性验证。
- [x] 输出数据字典和表级存储位置，明确浏览器 localStorage 仅保存筛选偏好。

### 任务 5：安全演示数据与全流程检查

**文件：** `scripts/seed-workforce-demo.js`、`scripts/verify-workforce-e2e.js`、`test/seed-workforce-demo.test.js`、`README.md`。

- [x] 扩充幂等演示数据：主管、师傅、管家、工单状态、排班、请假、冲突、绩效和报告。
- [x] 演示密码只从环境变量读取，不写入仓库、日志或生产默认配置。
- [x] 提供种子与验证命令，覆盖主要注册、登录、工单、排班、报告和停用账号链路。
- [x] 明确 Render 生产环境关闭演示种子，Supabase/Render 数据备份先验证再迁移。

### 任务 6：API 文档与安全报告

**文件：** `docs/API.md`、`README.md`、`介绍.md`、`services/database-inspection.js`。

- [x] 按认证、人员、注册审核、工单、小区、排班、报告、持久化分类整理当前 API：方法、路径、权限、请求、响应和错误码。
- [x] 记录已修复的风险、剩余风险、生产环境变量和数据恢复步骤。
- [x] 完成静态路由扫描与测试结果汇总。

### 验证命令

```bash
node --test --test-concurrency=1 test/auth-security.test.js test/profiles-api.test.js test/ticket-community.test.js
node --test --test-concurrency=1 test/database-persistence.test.js test/verify-supabase-persistence.test.js test/seed-workforce-demo.test.js
npm test
git diff --check
```
