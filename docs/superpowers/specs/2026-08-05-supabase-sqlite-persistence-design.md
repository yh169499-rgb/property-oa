# Supabase 独立数据库快照持久化设计

## 目标

在不重写现有 SQL.js 同步查询接口的前提下，将生产 SQLite 数据库独立保存到 Supabase 私有 Storage，避免 Render Free Web Service 在重新部署、休眠或重启后丢失账号、工单、组织、排班、考勤、模板和日志数据，并提供可重复的流程演示数据。

## 方案与边界

- 继续使用现有 `sql.js` 和 `data.db`，不进行本轮 PostgreSQL 查询层重写。
- Supabase Storage 使用私有 bucket 保存数据库快照；Render 仅通过服务端密钥访问，浏览器不接触密钥。
- 当前服务按单实例运行，采用“启动下载、变更后上传”的一致性模型；多实例部署前必须改为真正的 PostgreSQL 或增加分布式锁。
- 本地开发未配置 Supabase 凭据时继续使用本地 `data.db`，测试不访问线上数据。

## 配置

新增环境变量：

| 变量 | 作用 |
| --- | --- |
| `SUPABASE_URL` | Supabase 项目地址 |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅服务端使用的 Storage 访问密钥 |
| `SUPABASE_STORAGE_BUCKET` | 私有 bucket 名称，默认 `property-oa-data` |
| `SUPABASE_DB_OBJECT` | 数据库对象路径，默认 `production/data.db` |
| `SUPABASE_BACKUP_PREFIX` | 备份对象前缀，默认 `backups` |
| `SUPABASE_SYNC_REQUIRED` | 生产环境设为 `true` 时，无法下载远程数据库则阻止启动 |

Render 的 `DB_PATH` 仍作为本地运行时缓存路径；`UPLOAD_DIR` 仍保存附件缓存。数据库快照与附件是两个独立对象，附件后续可迁移到 Supabase Storage 的 `uploads/` 前缀。

## 启动流程

1. 读取并校验 Supabase 配置。
2. 请求私有 bucket 中的 `production/data.db`。
3. 若远程文件存在，原子写入临时文件后替换本地 `DB_PATH`。
4. 若远程文件不存在且 `SUPABASE_SYNC_REQUIRED=true`，启动失败并记录明确错误；开发环境允许从本地数据库初始化。
5. 调用现有 `initDB()`，执行表结构迁移和默认小区初始化。
6. 启动后执行一次完整快照上传，确保结构迁移结果回写远程数据库。

## 写入与备份流程

- 现有 `saveDB()` 保留本地同步写入行为，并触发一个串行远程同步队列。
- 队列同一时间只允许一个上传任务；新写入在上传期间合并为下一次任务，避免并发覆盖。
- 上传前先写入带时间戳的备份对象：`backups/YYYY-MM-DDTHH-mm-ss-sssZ.data.db`。
- 主对象上传采用临时对象后覆盖，避免产生半截数据库文件。
- 上传失败不回滚用户刚完成的本地操作；记录错误并按指数退避重试，健康检查暴露最近一次同步状态。
- 进程退出时等待当前同步任务完成，最多等待 5 秒。

## 首次迁移

使用显式命令从指定数据库文件上传，避免误把开发库覆盖生产库：

```bash
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
DB_PATH=/absolute/path/to/data.db \
node scripts/migrate-sqlite-to-supabase.js --source=/absolute/path/to/data.db --confirm
```

命令输出表清单和记录数量，但不输出密码、JWT 或服务密钥。上传前自动生成一份本地 `.bak` 文件。

## 演示数据

保留现有 `scripts/seed-workforce-demo.js` 的幂等行为，并增加远程数据库模式：

```bash
SEED_WORKFORCE_DEMO=true \
DB_PATH=/absolute/path/to/data.db \
node scripts/seed-workforce-demo.js
```

演示数据覆盖：主管、师傅、管家账号；人员层级；白班和跨夜班模板；近 7 天排班和考勤；处理中、待处理、已完成工单；个人、主管和报告查询所需的关联数据。账号密码只通过现有账号创建流程或明确的测试环境变量提供，不写入日志和文档。

## 验证

- 单元测试：配置校验、下载/上传重试、串行队列、原子替换和失败状态。
- 迁移测试：源库表数量、每张表记录数、关键用户和工单字段在上传下载后保持一致。
- 流程验证：登录 → 主管工作台 → 组织层级 → 模板 → 排班 → 师傅日程 → 考勤 → 工单报告。
- 线上验证：部署后检查健康接口中的远程同步状态，并重新部署一次确认账号仍可登录。

## 故障与恢复

- Supabase 暂不可用时，已有实例继续使用本地缓存，但健康状态标记为降级；生产启动若没有可用远程快照则拒绝启动。
- 误写入时从最近的 `backups/` 对象下载并通过迁移命令恢复。
- 服务扩容为多实例前必须停止使用文件快照方案，迁移到 PostgreSQL，并启用事务和连接池。
