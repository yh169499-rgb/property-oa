# 数据安全审查与运行手册

## 已落实的安全边界

1. 主管是唯一最高管理角色；注册申请只能成为维修师傅或物业管家，不能由客户端提交主管角色。
2. JWT 不再只验证签名。每个请求都会读取账号当前状态，停用账号后既有令牌立即失效。
3. 删除人员采用可审计的停用：登录权限撤销，人员档案置为 inactive，清理小区成员关系、排班、考勤和状态；工单及操作日志保留，避免历史报告断链。
4. 工单、附件、小区、状态、报告、提醒、SLA、班次模板等接口都必须登录；写入型管理接口需要主管权限。
5. 附件限制为图片/PDF、10MB/文件、10 个/次；JSON 请求体限制为 1MB；附件下载也必须登录并通过工单小区范围校验。
6. Render 健康检查使用公开 `/api/health`，业务状态接口不再作为匿名探针。
7. 普通人员的小区、通知、在岗状态和附件请求按本人小区/工单范围过滤，邀请码和旧版全量报告不向普通人员开放。
8. 排班查询对普通人员强制收敛到本人档案，主管才可以读取全员班次和请假备注。
9. 当前登录态按浏览器标签页隔离；密码写入限制为 8–128 位，避免弱密码和超长 bcrypt 资源消耗。
10. 生产启动拒绝缺失或弱 JWT_SECRET；旧版未完成权限隔离的 `index.js` 默认禁止启动。
11. Express 关闭版本指纹并增加基础安全响应头；上传和未捕获异常统一返回稳定错误，不返回堆栈路径。
12. 生产依赖已升级并锁定安全版本，`npm audit --omit=dev` 当前为 0 个漏洞。

## 数据存储检查清单

- SQLite 文件由 `DB_PATH` 指定，Render 使用 `/var/data/data.db` 持久磁盘。
- Supabase Storage 同步由 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_STORAGE_BUCKET`、`SUPABASE_DB_OBJECT` 控制；服务端密钥绝不写入前端。
- `SUPABASE_SYNC_REQUIRED=true` 时首次同步失败会阻止启动；生产建议开启并配置备份桶策略。
- 主管可通过 `/api/persistence/status` 查看最近同步时间、待上传状态和错误。
- 模拟数据不会在 Render 启动时自动写入；`render.yaml` 已关闭 `SEED_WORKFORCE_DEMO`。

## 模拟数据与全流程测试

仅在测试数据库执行：

```bash
DEMO_PASSWORD='仅用于测试的临时密码' \
SEED_WORKFORCE_DEMO=true \
DB_PATH=/tmp/property-oa-demo.db \
node scripts/seed-workforce-demo.js
```

种子数据包含主管、维修师傅、管家、班次模板、跨夜班、请假、考勤、待派单/处理中/待确认/已完成工单以及可用于报告和绩效计算的关联数据。脚本按手机号、模板名、排班日期和工单 ID 幂等执行，不会重复插入。

演示账号手机号：`13800000011`（主管）、`13800000012`（维修师傅）、`13800000013`（物业管家）。密码只取 `DEMO_PASSWORD` 环境变量，不写入仓库或文档。

## 固定 7 账号生产迁移与回滚

`retained:*` 命令用于一次性规范固定测试账号并补齐 `MOCK-E2E` 全流程数据，不允许作为 Render 启动种子运行：

```bash
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:dry-run -- --source=/absolute/path/to/candidate.db
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:apply -- --source=/absolute/path/to/candidate.db
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:verify -- --source=/absolute/path/to/candidate.db
```

安全顺序：

1. 暂停人工写入，下载 Render `/var/data/data.db` 和 Supabase `production/data.db` 两份原始备份。
2. 比较 SHA-256、表集合和记录数；不一致时，以冻结写入后下载的 Render 数据为候选主库，Supabase 原文件保留为第二回滚点。
3. 仅在候选副本运行 dry-run；确认摘要后再执行 apply。apply 要求绝对路径、固定确认口令和运行时 `RETAINED_TEST_PASSWORD`，并在同目录先生成 `.before-retained-*.db` 备份再原子写回。
4. `retained:verify` 必须返回 `ok: true`，再替换 Render 数据库并运行 `npm run migrate:supabase`、`npm run verify:supabase`。
5. 逐一验证 7 个账号；验证普通人员不能访问主管管理功能，并验证任一已停用账号及其旧 JWT 均返回 401。
6. 重启 Render 后再次验证数据。验收完成前不得删除 Render、Supabase 和 apply 自动生成的三个回滚点。

回滚时先停止服务写入，把执行前 Render 备份恢复到 `/var/data/data.db`，再将同一文件同步至 Supabase，最后运行 `npm run verify:supabase`。迁移工具的输出只包含路径、计数和问题码，不包含密码、哈希、JWT 或服务端密钥。

## 仍需外部配置的事项

- 忘记密码流程目前要求登录后修改本人密码；无短信/邮件供应商时，忘记密码由主管处理。接入短信供应商后，应将一次性验证码存哈希、限时、限次并作废。
- 同源部署默认关闭跨域；如前后端分域，生产环境应设置 `CORS_ORIGINS` 为实际前端域名列表。
- 应在 Render 设置高熵 `JWT_SECRET`、Supabase service role key 和 AI/通知密钥，并定期轮换。
- `SUPABASE_SYNC_REQUIRED` 当前由部署配置控制；生产应在确认 Storage bucket、策略和 service role key 正确后设置为 `true`，让远程快照同步失败时阻止启动，避免误以本地旧库提供服务。
