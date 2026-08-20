# 独立空白主管账号实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。

**目标：** 保留全部既有测试数据，新增一个无下属、无 mock 业务数据的主管账号，并支持多个主管分别管理最多 4 名人员；页面标题统一为“工单系统”。

**架构：** 通过启动开关调用幂等账号迁移服务，迁移只写入 `users` 和 `staff_profiles`，不触碰工单等业务表。人员创建根据当前登录主管选择直属主管，团队容量按主管独立统计；前端 logo 不再拼接小区名称。

**技术栈：** Node.js、Express、sql.js/SQLite、bcryptjs、Node Test Runner、原生前端 JavaScript。

---

### 任务 1：支持多个主管按当前主管分配人员

**文件：**
- 修改：`services/team-capacity.js`
- 修改：`services/staff-lifecycle.js`
- 测试：`test/team-capacity.test.js`
- 测试：`test/staff-lifecycle.test.js`

- [ ] **步骤 1：编写失败测试**

新增测试场景：fixture 中插入第二个 active 主管；以第二主管的用户 ID 创建普通人员，断言新档案的 `manager_id` 指向第二主管；为第二主管创建第 5 名人员时断言 `TEAM_CAPACITY_FULL`，而第一主管的容量不受影响。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/team-capacity.test.js test/staff-lifecycle.test.js`

预期：新增“按当前主管分配”测试失败，原因是当前实现调用 `findSoleSupervisorProfile` 并在多主管时返回 `MULTIPLE_SUPERVISOR_PROFILES`。

- [ ] **步骤 3：实现最少代码**

在 `services/team-capacity.js` 增加 `findSupervisorProfile(db, userId)`，按 `staff_profiles.user_id` 查找 active 主管并返回 `SUPERVISOR_PROFILE_NOT_FOUND` 或 `SUPERVISOR_PROFILE_INVALID`；保留 `findSoleSupervisorProfile` 兼容旧调用和既有测试。`services/staff-lifecycle.js` 的 `insertStaff` 使用 `actorUser.id` 调用新函数，再对该主管执行 `assertTeamCapacity`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/team-capacity.test.js test/staff-lifecycle.test.js`

预期：全部通过，且每个主管的直属 active 人员总数不得超过 4。

- [ ] **步骤 5：提交**

```bash
git add services/team-capacity.js services/staff-lifecycle.js test/team-capacity.test.js test/staff-lifecycle.test.js
git commit -m "feat: 支持多主管分别管理四名人员"
```

### 任务 2：新增幂等的独立空白主管迁移

**文件：**
- 创建：`services/standalone-manager.js`
- 创建：`services/startup-standalone-manager.js`
- 修改：`index-new.js`
- 创建：`test/standalone-manager.test.js`

- [ ] **步骤 1：编写失败测试**

测试 `ensureStandaloneManager`：首次执行创建 active `主管` 用户和 `manager_id IS NULL` 的档案；重复执行不增加用户/档案；手机号已属于普通人员时返回 `STANDALONE_MANAGER_PHONE_CONFLICT`；数据库已有工单时工单行数保持不变。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/standalone-manager.test.js`

预期：因服务模块尚不存在而失败。

- [ ] **步骤 3：实现最少代码**

`services/standalone-manager.js` 使用 `bcrypt.hashSync(password, 10)`，校验手机号、姓名、密码，按手机号查询用户；新建或更新主管用户和档案，明确 `manager_id = NULL`，绝不插入 tickets、shift_assignments、leave、attendance、report 相关表。普通用户同手机号时抛出冲突。所有数据库变更放在事务中。

`services/startup-standalone-manager.js` 仅当 `APPLY_STANDALONE_MANAGER_ON_START=true` 时运行；读取 `STANDALONE_MANAGER_PHONE`、`STANDALONE_MANAGER_NAME`、`STANDALONE_MANAGER_PASSWORD`，缺少任一项则抛出配置错误；成功后调用 `persist`。

在 `index-new.js` 的 `initDB()` 后、监听端口前调用启动迁移，并输出不含密码的摘要。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/standalone-manager.test.js test/startup-retained-migration.test.js`

预期：迁移、幂等、冲突、关闭开关和业务数据不变测试全部通过。

- [ ] **步骤 5：提交**

```bash
git add services/standalone-manager.js services/startup-standalone-manager.js index-new.js test/standalone-manager.test.js
git commit -m "feat: 增加无 mock 数据的独立主管迁移"
```

### 任务 3：清理测试小区标题

**文件：**
- 修改：`public/app.js`
- 修改：`test/frontend-feature.test.js`

- [ ] **步骤 1：编写失败测试**

增加静态断言：`updateLogo` 不得拼接小区名称，源码中应固定出现 `🏢 工单系统`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/frontend-feature.test.js`

预期：新增标题断言失败，因为当前代码会输出“全流程测试小区工单系统”。

- [ ] **步骤 3：实现最少代码**

将 `updateLogo` 的赋值改为 `logo.textContent = '🏢 工单系统'`，保留小区切换逻辑但不改变系统标题。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/frontend-feature.test.js`

预期：所有前端静态测试通过。

- [ ] **步骤 5：提交**

```bash
git add public/app.js test/frontend-feature.test.js
git commit -m "fix: 统一显示工单系统标题"
```

### 任务 4：完整回归与部署配置说明

**文件：**
- 修改：`README.md`
- 修改：`render.yaml`

- [ ] **步骤 1：补充环境变量说明**

记录生产环境需要配置：

```text
APPLY_STANDALONE_MANAGER_ON_START=true
STANDALONE_MANAGER_PHONE=13222514178
STANDALONE_MANAGER_NAME=发财
STANDALONE_MANAGER_PASSWORD=<仅填密码，不提交到 Git>
```

- [ ] **步骤 2：运行回归验证**

运行：

```bash
node --check services/team-capacity.js services/staff-lifecycle.js services/standalone-manager.js services/startup-standalone-manager.js index-new.js public/app.js
node --test --test-concurrency=1 test/team-capacity.test.js test/staff-lifecycle.test.js test/standalone-manager.test.js test/startup-retained-migration.test.js test/frontend-feature.test.js
git diff --check
```

预期：语法检查通过，指定测试全部通过，`git diff --check` 无输出。

- [ ] **步骤 3：提交**

```bash
git add README.md render.yaml
git commit -m "docs: 说明独立主管生产迁移配置"
```
