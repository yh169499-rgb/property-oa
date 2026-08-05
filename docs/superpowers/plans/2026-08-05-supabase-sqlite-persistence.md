# Supabase SQLite 持久化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 将现有 SQL.js 数据库快照独立保存到 Supabase 私有 Storage，并在部署后恢复、同步和验证完整业务演示数据。

**架构：** 新增无状态的 Supabase Storage 适配器，负责下载、原子替换、备份和上传 SQLite 文件；`db.js` 保留同步 SQL.js API，仅在初始化和 `saveDB()` 边界接入适配器。单实例下用串行同步队列避免并发覆盖，缺少远程配置时保持本地开发行为。

**技术栈：** Node.js、`sql.js`、现有 `node-fetch`、Supabase Storage REST API、Node Test Runner、Render 环境变量。

---

### 任务 1：配置与 Supabase Storage 适配器

**文件：**
- 修改：`config.js`
- 创建：`services/supabase-storage.js`
- 测试：`test/supabase-storage.test.js`

- [x] **步骤 1：编写失败测试**

测试 `getSupabaseStorageConfig()` 在缺少凭据时返回 disabled；测试 `atomicWriteFile()` 写入临时文件后替换目标；测试 `enqueueUpload()` 同时调用两次时只保留串行上传。

```js
test('缺少 Supabase 凭据时不启用远程同步', () => {
  assert.equal(getSupabaseStorageConfig({}), null);
});

test('远程上传队列按顺序执行', async () => {
  const order = [];
  const queue = createUploadQueue(async value => { order.push(value); });
  await Promise.all([queue.enqueue('a'), queue.enqueue('b')]);
  assert.deepEqual(order, ['a', 'b']);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/supabase-storage.test.js`

预期：FAIL，提示适配器导出函数不存在。

- [x] **步骤 3：实现最小适配器**

`config.js` 增加 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_STORAGE_BUCKET`、`SUPABASE_DB_OBJECT`、`SUPABASE_BACKUP_PREFIX` 和 `SUPABASE_SYNC_REQUIRED`；`services/supabase-storage.js` 使用 `node-fetch` 调用 Storage REST API，导出 `getSupabaseStorageConfig`、`downloadDatabase`、`uploadDatabase`、`createUploadQueue` 和 `atomicWriteFile`。

- [x] **步骤 4：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/supabase-storage.test.js test/config-env.test.js`

预期：全部通过，且测试不会访问真实 Supabase。

- [x] **步骤 5：Commit**

```bash
git add config.js services/supabase-storage.js test/supabase-storage.test.js
git commit -m "feat: add Supabase storage adapter"
```

### 任务 2：接入数据库启动恢复和写入同步

**文件：**
- 修改：`db.js`
- 创建：`services/persistence-status.js`
- 测试：`test/database-persistence.test.js`

- [x] **步骤 1：编写失败测试**

测试初始化时远程快照优先于本地缓存；测试远程文件不存在且 `SYNC_REQUIRED=true` 时拒绝启动；测试 `saveDB()` 写入本地后触发上传队列并更新同步状态。

```js
test('远程快照优先恢复本地数据库', async () => {
  await restoreRemoteSnapshot({ remoteBytes: fixtureDb, localPath });
  assert.deepEqual(fs.readFileSync(localPath), fixtureDb);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/database-persistence.test.js`

预期：FAIL，当前 `initDB()` 不读取远程快照且没有同步状态。

- [x] **步骤 3：实现数据库边界接入**

在 `initDB()` 中先调用远程恢复，再执行现有建表和迁移；`saveDB()` 保留同步本地写入并将导出的 Buffer 放入串行上传队列；上传前保存时间戳备份；导出 `getPersistenceStatus()` 给健康检查使用；进程退出注册最多 5 秒的 flush。

- [x] **步骤 4：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/database-persistence.test.js test/server-app.test.js`

预期：持久化测试和既有服务测试全部通过。

- [x] **步骤 5：Commit**

```bash
git add db.js services/persistence-status.js test/database-persistence.test.js
git commit -m "feat: sync SQLite database snapshots to Supabase"
```

### 任务 3：首次迁移命令与完整数据盘点

**文件：**
- 创建：`scripts/migrate-sqlite-to-supabase.js`
- 创建：`services/database-inspection.js`
- 创建：`test/database-migration.test.js`
- 修改：`package.json`

- [x] **步骤 1：编写失败测试**

测试迁移命令拒绝缺少 `--confirm`；测试迁移摘要包含所有表名和记录数；测试密码列只计数不打印具体值。

- [x] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/database-migration.test.js`

预期：FAIL，迁移脚本和摘要函数尚不存在。

- [x] **步骤 3：实现迁移与盘点**

迁移脚本读取 `--source` 指定的 SQLite 文件，先复制 `${source}.bak`，通过数据库适配器上传 `production/data.db`，再输出固定顺序的表清单、记录数、源文件 SHA-256 和远程对象路径；增加 `npm run migrate:supabase -- --source=... --confirm`。

- [x] **步骤 4：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/database-migration.test.js`

预期：迁移参数、摘要和敏感字段保护测试全部通过。

- [x] **步骤 5：Commit**

```bash
git add scripts/migrate-sqlite-to-supabase.js services/database-inspection.js test/database-migration.test.js package.json
git commit -m "feat: add SQLite to Supabase migration command"
```

### 任务 4：演示数据、健康检查与部署配置

**文件：**
- 修改：`scripts/seed-workforce-demo.js`
- 修改：`routes/workforce-reports.js`
- 修改：`render.yaml`
- 修改：`README.md`
- 创建：`test/persistence-health.test.js`

- [x] **步骤 1：编写失败测试**

测试健康接口返回 `remote_enabled`、`last_sync_at`、`last_sync_error` 和 `pending_upload`；测试演示种子运行两次时第二次不增加模板、排班、考勤或工单数量。

- [x] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/persistence-health.test.js test/seed-workforce-demo.test.js`

预期：FAIL，健康字段和远程同步状态尚未暴露。

- [x] **步骤 3：实现最小功能**

在受保护的管理健康接口返回持久化状态；保留现有幂等种子并补齐主管、师傅、管家、模板、7 天排班考勤和 6 张工单；`render.yaml` 增加 Supabase 非敏感配置项，敏感密钥使用 `sync: false`，README 增加创建 bucket、设置变量、迁移和种子命令。

- [x] **步骤 4：运行测试确认通过**

运行：`node --test --test-concurrency=1 test/persistence-health.test.js test/seed-workforce-demo.test.js test/management-template-ui.test.js test/my-page.test.js`

预期：健康状态、种子幂等性和现有工作台测试全部通过。

- [x] **步骤 5：Commit**

```bash
git add scripts/seed-workforce-demo.js routes/workforce-reports.js render.yaml README.md test/persistence-health.test.js
git commit -m "feat: add persistence health and demo data verification"
```

### 任务 5：迁移、线上验证和回滚检查

**文件：**
- 修改：`docs/superpowers/specs/2026-08-05-supabase-sqlite-persistence-design.md`
- 创建：`scripts/verify-supabase-persistence.js`
- 测试：`test/verify-supabase-persistence.test.js`

- [x] **步骤 1：编写失败测试**

测试验证脚本比较迁移前后的表集合和记录数量，并检测远程对象存在。

- [x] **步骤 2：运行测试确认失败**

运行：`node --test --test-concurrency=1 test/verify-supabase-persistence.test.js`

预期：FAIL，验证脚本尚不存在。

- [x] **步骤 3：实现验证脚本**

脚本从远程下载快照到临时目录，输出表数量、记录数量、对象大小和 SHA-256；在 `SUPABASE_SYNC_REQUIRED=true` 时远程对象缺失返回非零退出码。

- [x] **步骤 4：运行验证**

运行：`node --test --test-concurrency=1 test/verify-supabase-persistence.test.js test/render-persistence-config.test.js test/config-env.test.js`

预期：全部通过；真实 Supabase 验证命令只在配置环境变量后运行。

- [x] **步骤 5：Commit**

```bash
git add scripts/verify-supabase-persistence.js test/verify-supabase-persistence.test.js docs/superpowers/specs/2026-08-05-supabase-sqlite-persistence-design.md
git commit -m "test: verify Supabase database persistence"
```

---

## 自检结果

- 规格中的启动恢复、写入同步、备份、首次迁移、演示数据、健康检查和恢复路径分别由任务 1 至任务 5 覆盖。
- 已检查计划文本，不包含 TODO、待定或未定义的实现占位符。
- 所有任务使用相同配置名：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_STORAGE_BUCKET`、`SUPABASE_DB_OBJECT`、`SUPABASE_BACKUP_PREFIX`、`SUPABASE_SYNC_REQUIRED`。