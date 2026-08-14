# 保留测试账号与全流程模拟数据实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 安全迁移指定数据库，仅保留 7 个测试账号为 active、停用其他账号并保留历史，同时写入幂等的人员、组织、排班、工单、活动、绩效与报告测试数据。

**架构：** 新增一个不依赖运行中 `db.js` 全局连接的离线迁移服务：读取指定 SQLite 文件到内存，在单个事务中规范账号和人员数据、写入固定 `MOCK-E2E` 数据，再导出新字节。CLI 默认 dry-run；只有绝对路径、密码环境变量、`--apply` 和固定确认口令同时满足时，才先创建同目录备份并原子写回。线上替换和 Supabase 上传复用现有迁移/验证脚本，并在部署步骤中单独执行。

**技术栈：** Node.js、sql.js/SQLite、bcryptjs、Node 内置测试、Supabase Storage、Render Persistent Disk。

---

## 文件结构

- 创建 `services/retained-test-data.js`：固定账号清单、数据库迁移事务、人员/组织/小区规范化、`MOCK-E2E` 数据生成和摘要。
- 创建 `scripts/prepare-retained-test-data.js`：安全 CLI 参数校验、dry-run、备份、原子写回和无敏感信息输出。
- 创建 `scripts/verify-retained-test-data.js`：账号、角色、密码哈希、active 范围、模拟工单、组织、权限、绩效样本和幂等结果验证。
- 创建 `test/retained-test-data.test.js`：迁移服务的 TDD 覆盖。
- 创建 `test/prepare-retained-test-data.test.js`：CLI 参数、备份和 dry-run 的 TDD 覆盖。
- 创建 `test/verify-retained-test-data.test.js`：验证器成功/失败场景。
- 修改 `package.json`：增加 dry-run、apply 和 verify 命令入口。
- 修改 `docs/SECURITY-AUDIT.md`：记录线上备份、迁移、验证、回滚与密码轮换操作。
- 修改 `docs/API.md`：记录账号停用后登录/令牌行为，不新增公开业务 API。
- 修改 `README.md`：增加一次性测试数据准备命令和生产禁用规则。
- 修改 `docs/superpowers/specs/2026-08-12-retained-test-accounts-and-mock-data-design.md`：移除测试密码明文，仅保留环境变量契约。

### 任务 1：定义固定账号契约和安全迁移摘要

**文件：**
- 创建：`services/retained-test-data.js`
- 创建：`test/retained-test-data.test.js`

- [ ] **步骤 1：编写固定账号清单和摘要的失败测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RETAINED_ACCOUNTS,
  planRetainedTestData,
} = require('../services/retained-test-data');

test('固定清单只包含一个主管、四个师傅和两个管家', () => {
  assert.deepEqual(RETAINED_ACCOUNTS.map(({ phone, role }) => [phone, role]), [
    ['13800000001', '主管'],
    ['13800000002', 'worker'],
    ['13800000003', 'worker'],
    ['13800000004', 'worker'],
    ['13800000005', 'worker'],
    ['13800000006', 'keeper'],
    ['13800000007', 'keeper'],
  ]);
});

test('预演摘要不包含密码、哈希或令牌', async () => {
  const db = await fixtureWithExtraUser();
  const result = planRetainedTestData(db, {
    password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  });
  assert.equal(result.summary.retainedAccounts, 7);
  assert.equal(result.summary.disabledAccounts, 1);
  assert.doesNotMatch(JSON.stringify(result.summary), /runtime-secret|password|hash|token/i);
});
```

- [ ] **步骤 2：运行测试确认因模块缺失而失败**

运行：

```bash
node --test test/retained-test-data.test.js
```

预期：FAIL，错误包含 `Cannot find module '../services/retained-test-data'`。

- [ ] **步骤 3：实现最小固定账号契约和预演摘要**

```js
const RETAINED_ACCOUNTS = Object.freeze([
  { phone: '13800000001', name: '主管', role: '主管', position: '主管' },
  { phone: '13800000002', name: '张师傅', role: 'worker', position: '维修师傅' },
  { phone: '13800000003', name: '李师傅', role: 'worker', position: '维修师傅' },
  { phone: '13800000004', name: '王师傅', role: 'worker', position: '维修师傅' },
  { phone: '13800000005', name: '赵师傅', role: 'worker', position: '维修师傅' },
  { phone: '13800000006', name: '陈管家', role: 'keeper', position: '物业管家' },
  { phone: '13800000007', name: '周管家', role: 'keeper', position: '物业管家' },
]);

function planRetainedTestData(db) {
  const retainedPhones = new Set(RETAINED_ACCOUNTS.map(item => item.phone));
  const users = rows(db, 'SELECT id, phone FROM users');
  return {
    summary: {
      retainedAccounts: RETAINED_ACCOUNTS.length,
      disabledAccounts: users.filter(user => !retainedPhones.has(String(user.phone))).length,
    },
  };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/retained-test-data.test.js`

预期：2 个测试 PASS，输出不含密码。

- [ ] **步骤 5：提交本任务**

```bash
git add services/retained-test-data.js test/retained-test-data.test.js
git commit -m "test: define retained account migration contract"
```

### 任务 2：事务化规范账号并停用其他人员

**文件：**
- 修改：`services/retained-test-data.js`
- 修改：`test/retained-test-data.test.js`

- [ ] **步骤 1：编写账号规范化和历史保留的失败测试**

```js
test('只激活固定账号并停用其他账号但保留历史工单和活动', async () => {
  const db = await fixtureWithExtraUser();
  const originalTickets = count(db, 'tickets');
  const originalLogs = count(db, 'ticket_activity_logs');
  migrateRetainedTestData(db, {
    password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  });

  assert.deepEqual(rows(db,
    "SELECT phone, role, status FROM users WHERE status = 'active' ORDER BY phone"
  ).map(row => [row.phone, row.role, row.status]), [
    ['13800000001', '主管', 'active'],
    ['13800000002', 'worker', 'active'],
    ['13800000003', 'worker', 'active'],
    ['13800000004', 'worker', 'active'],
    ['13800000005', 'worker', 'active'],
    ['13800000006', 'keeper', 'active'],
    ['13800000007', 'keeper', 'active'],
  ]);
  assert.equal(one(db, "SELECT status FROM users WHERE phone = '13900000000'").status, 'disabled');
  assert.equal(one(db, "SELECT employment_status FROM staff_profiles WHERE user_id = 99").employment_status, 'inactive');
  assert.equal(count(db, 'tickets'), originalTickets);
  assert.equal(count(db, 'ticket_activity_logs'), originalLogs);
});

test('迁移失败时回滚账号与档案变更', async () => {
  const db = await fixtureWithExtraUser();
  db.run(`CREATE TRIGGER fail_profile_update BEFORE UPDATE ON staff_profiles
    BEGIN SELECT RAISE(ABORT, 'simulated migration failure'); END`);
  assert.throws(() => migrateRetainedTestData(db, {
    password: 'runtime-secret', now: new Date('2026-08-12T02:00:00.000Z'),
  }), /simulated migration failure/);
  assert.equal(one(db, "SELECT role FROM users WHERE phone = '13800000001'").role, 'admin');
});
```

- [ ] **步骤 2：运行测试确认因迁移行为缺失而失败**

运行：`node --test test/retained-test-data.test.js`

预期：FAIL，固定账号数量/状态或 `migrateRetainedTestData` 与断言不符。

- [ ] **步骤 3：实现单事务账号迁移**

实现要求：

```js
function migrateRetainedTestData(db, { password, now }) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('RETAINED_TEST_PASSWORD 至少 10 位');
  }
  ensureUsersStatusColumn(db);
  ensureWorkforceSchema(db);
  db.run('BEGIN IMMEDIATE');
  try {
    for (const account of RETAINED_ACCOUNTS) {
      upsertRetainedUser(db, account, bcrypt.hashSync(password, 10));
    }
    disableNonRetainedUsers(db, RETAINED_ACCOUNTS.map(item => item.phone), now.toISOString());
    const summary = buildSummary(db);
    db.run('COMMIT');
    return { summary };
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw error;
  }
}
```

`disableNonRetainedUsers` 只更新账号/档案状态并删除当前关系、排班、考勤和实时状态，不执行任何 `DELETE FROM tickets`、`DELETE FROM ticket_activity_logs`、`DELETE FROM ai_report_analyses`。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/retained-test-data.test.js`

预期：账号规范化、历史保留和事务回滚测试全部 PASS。

- [ ] **步骤 5：提交本任务**

```bash
git add services/retained-test-data.js test/retained-test-data.test.js
git commit -m "feat: normalize retained test accounts safely"
```

### 任务 3：补齐档案、组织和小区范围

**文件：**
- 修改：`services/retained-test-data.js`
- 修改：`test/retained-test-data.test.js`

- [ ] **步骤 1：编写人员和小区幂等测试**

```js
test('固定账号各有一个 active 档案并统一归主管管理', async () => {
  const db = await fixtureWithExtraUser();
  migrateRetainedTestData(db, options());
  const profiles = rows(db, `SELECT u.phone, sp.name, sp.position, sp.employment_status,
    manager.phone manager_phone
    FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
    LEFT JOIN staff_profiles manager_profile ON manager_profile.id = sp.manager_id
    LEFT JOIN users manager ON manager.id = manager_profile.user_id
    WHERE u.status = 'active' ORDER BY u.phone`);
  assert.equal(profiles.length, 7);
  assert.equal(profiles[0].manager_phone, null);
  assert.ok(profiles.slice(1).every(profile => profile.manager_phone === '13800000001'));
});

test('重复迁移不会重复创建档案、小区和成员关系', async () => {
  const db = await fixtureWithExtraUser();
  migrateRetainedTestData(db, options());
  const first = snapshotCounts(db, ['staff_profiles', 'communities', 'community_memberships']);
  migrateRetainedTestData(db, options());
  assert.deepEqual(snapshotCounts(db, ['staff_profiles', 'communities', 'community_memberships']), first);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/retained-test-data.test.js`

预期：FAIL，档案数、主管关系或幂等数量不正确。

- [ ] **步骤 3：实现档案和小区 upsert**

实现要求：

- 以 `users.phone` 查用户，以 `staff_profiles.user_id` 查档案；
- 只在原字段为空时补 `join_date`、`birth_month` 和 `skill`；
- 姓名、手机号、职位、角色和 active 状态按固定清单规范化；
- 主管 `manager_id = NULL`，其他 6 人 `manager_id = 主管档案 ID`；
- 保证 `default` 小区存在；
- 以固定 ID `mock-e2e-community` 创建模拟小区；
- 7 人加入 `default`，主管和指定跨区样本人员加入模拟小区；
- inactive 人员不重新加入任何小区。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/retained-test-data.test.js`

预期：人员、组织、小区和重复迁移测试 PASS。

- [ ] **步骤 5：提交本任务**

```bash
git add services/retained-test-data.js test/retained-test-data.test.js
git commit -m "feat: connect retained staff organization and communities"
```

### 任务 4：生成班次、请假和日历冲突样本

**文件：**
- 修改：`services/retained-test-data.js`
- 修改：`test/retained-test-data.test.js`

- [ ] **步骤 1：编写排班场景失败测试**

```js
test('模拟排班覆盖白班、跨夜班、请假和未排班状态', async () => {
  const db = await fixtureWithExtraUser();
  migrateRetainedTestData(db, options());
  assert.equal(one(db, "SELECT COUNT(*) total FROM shift_templates WHERE name IN ('模拟白班','模拟夜班')").total, 2);
  assert.ok(one(db, "SELECT COUNT(*) total FROM shift_assignments WHERE note LIKE 'MOCK-E2E%'").total >= 12);
  assert.ok(one(db, "SELECT COUNT(*) total FROM shift_assignments WHERE note LIKE 'MOCK-E2E%' AND assignment_type = 'leave'").total >= 1);
  assert.ok(one(db, "SELECT COUNT(*) total FROM shift_assignments WHERE note LIKE 'MOCK-E2E%' AND end_at < start_at").total === 0);
  assert.equal(one(db, "SELECT COUNT(*) total FROM attendance_records WHERE updated_at LIKE 'MOCK-E2E%'").total, 0);
});
```

- [ ] **步骤 2：运行测试确认模拟排班缺失**

运行：`node --test test/retained-test-data.test.js`

预期：FAIL，模板或排班数量为 0。

- [ ] **步骤 3：实现动态日期排班数据**

使用上海时区的执行日生成最近 7 天和未来 3 天数据：

- 张师傅、李师傅正常白班；
- 王师傅某日模拟夜班，`start_at`/`end_at` 解析为跨日绝对时间；
- 赵师傅某日事假；
- 陈管家和周管家交替白班；
- 至少保留一天无排班，用于空状态展示；
- 所有模拟排班备注以 `MOCK-E2E` 开头；
- 不生成新的考勤记录，符合当前产品已移除考勤展示的口径。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/retained-test-data.test.js`

预期：排班场景和幂等测试 PASS。

- [ ] **步骤 5：提交本任务**

```bash
git add services/retained-test-data.js test/retained-test-data.test.js
git commit -m "feat: seed retained staff calendar scenarios"
```

### 任务 5：生成完整工单、活动和绩效样本

**文件：**
- 修改：`services/retained-test-data.js`
- 修改：`test/retained-test-data.test.js`

- [ ] **步骤 1：编写工单覆盖和历史隔离失败测试**

```js
test('每名普通测试人员均有足够已完成样本和当前工单', async () => {
  const db = await fixtureWithExtraUser();
  migrateRetainedTestData(db, options());
  const perPerson = rows(db, `SELECT u.phone,
    SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN t.status <> 'done' THEN 1 ELSE 0 END) current_count
    FROM users u JOIN tickets t ON t.assignee_user_id = u.id
    WHERE u.phone BETWEEN '13800000002' AND '13800000007' AND t.id LIKE 'MOCK-E2E-%'
    GROUP BY u.phone ORDER BY u.phone`);
  assert.equal(perPerson.length, 6);
  assert.ok(perPerson.every(row => row.completed >= 5 && row.current_count >= 1));
});

test('模拟工单覆盖状态、复发、多人反馈、紧急和多小区', async () => {
  const db = await fixtureWithExtraUser();
  migrateRetainedTestData(db, options());
  const rows = allMockTickets(db);
  assert.deepEqual(new Set(rows.map(row => row.status)), new Set(['wait', 'doing', 'pending', 'confirm', 'done']));
  assert.ok(rows.some(row => row.priority === 'urgent'));
  assert.ok(rows.some(row => Number(row.is_recurring) === 1));
  assert.ok(rows.some(row => Number(row.feedback_count) > 1));
  assert.ok(rows.some(row => row.community_id === 'mock-e2e-community'));
});

test('非 MOCK 历史工单完全不变', async () => {
  const db = await fixtureWithExtraUser();
  const before = one(db, "SELECT * FROM tickets WHERE id = 'REAL-HISTORY-001'");
  migrateRetainedTestData(db, options());
  assert.deepEqual(one(db, "SELECT * FROM tickets WHERE id = 'REAL-HISTORY-001'"), before);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/retained-test-data.test.js`

预期：FAIL，模拟工单数量/状态/样本不足。

- [ ] **步骤 3：实现固定 ID 的动态工单场景**

实现要求：

- 为 `13800000002` 至 `13800000007` 每人创建 5 张 `done` 和至少 1 张当前工单；
- 另建 1 张 `wait` 未派单紧急工单；
- 使用 `MOCK-E2E-<phone尾号>-DONE-01` 等稳定 ID；
- 已完成工单写入 `created`、`assigned_at`、`finished`、`estimated_hours` 和当前 `performance_rule_version_id`；
- 当前工单分布在 `doing`、`pending`、`confirm`；
- 至少一张 `is_recurring=1`、一张 `feedback_count>1`、一张 `priority='urgent'`；
- 小区分布在 `default` 和 `mock-e2e-community`；
- 用 `INSERT ... ON CONFLICT(id) DO UPDATE` 只更新 `MOCK-E2E-` 记录的白名单字段；
- 对每张模拟工单写入稳定的 `ticket_activity_logs`：主管派单、员工接单/完成、管家确认或退回；活动幂等通过 `ticket_id + action + metadata.mock_key` 检查。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/retained-test-data.test.js`

预期：工单覆盖、绩效样本、活动幂等和历史隔离全部 PASS。

- [ ] **步骤 5：提交本任务**

```bash
git add services/retained-test-data.js test/retained-test-data.test.js
git commit -m "feat: seed complete retained account ticket flows"
```

### 任务 6：实现安全 dry-run、备份和原子写回 CLI

**文件：**
- 创建：`scripts/prepare-retained-test-data.js`
- 创建：`test/prepare-retained-test-data.test.js`

- [ ] **步骤 1：编写 CLI 参数和文件行为失败测试**

```js
test('默认只预演且不修改源文件', async () => {
  const source = await writeFixtureDatabase();
  const before = fs.readFileSync(source);
  const result = await prepareRetainedTestData({
    source, apply: false, confirm: '', password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(result.backupPath, null);
});

test('apply 必须有绝对路径、确认口令和密码', async () => {
  await assert.rejects(prepareRetainedTestData({ source: 'data.db', apply: true, confirm: 'RETAINED-TEST-DATA', password: 'runtime-secret' }), /绝对路径/);
  await assert.rejects(prepareRetainedTestData({ source: '/tmp/data.db', apply: true, confirm: '', password: 'runtime-secret' }), /确认口令/);
  await assert.rejects(prepareRetainedTestData({ source: '/tmp/data.db', apply: true, confirm: 'RETAINED-TEST-DATA', password: '' }), /RETAINED_TEST_PASSWORD/);
});

test('apply 先生成同目录备份再原子写回', async () => {
  const source = await writeFixtureDatabase();
  const before = fs.readFileSync(source);
  const result = await prepareRetainedTestData({
    source, apply: true, confirm: 'RETAINED-TEST-DATA', password: 'runtime-secret',
    now: new Date('2026-08-12T02:00:00.000Z'),
  });
  assert.deepEqual(fs.readFileSync(result.backupPath), before);
  assert.notDeepEqual(fs.readFileSync(source), before);
  assert.equal(fs.existsSync(`${source}.tmp`), false);
});
```

- [ ] **步骤 2：运行测试确认 CLI 模块缺失**

运行：`node --test test/prepare-retained-test-data.test.js`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现离线 CLI**

参数契约：

```text
--source=/absolute/path/to/data.db
--apply
--confirm=RETAINED-TEST-DATA
--now=2026-08-12T02:00:00.000Z  # 仅测试/可重复演练使用
```

主流程：

```js
async function prepareRetainedTestData(options) {
  validateOptions(options);
  const original = fs.readFileSync(options.source);
  const db = new SQL.Database(original);
  const result = migrateRetainedTestData(db, options);
  const migrated = Buffer.from(db.export());
  if (!options.apply) return { mode: 'dry-run', backupPath: null, ...result.summary };
  const backupPath = backupDatabase(options.source, original, options.now);
  atomicWriteFile(options.source, migrated);
  return { mode: 'apply', backupPath, ...result.summary };
}
```

CLI 输出只包含 mode、源路径、备份路径、账号/档案/模拟数据数量和表级差异。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/prepare-retained-test-data.test.js`

预期：dry-run、不完整确认、备份和原子写回测试全部 PASS。

- [ ] **步骤 5：提交本任务**

```bash
git add scripts/prepare-retained-test-data.js test/prepare-retained-test-data.test.js
git commit -m "feat: add safe retained test data migration cli"
```

### 任务 7：实现全流程数据库验证器

**文件：**
- 创建：`scripts/verify-retained-test-data.js`
- 创建：`test/verify-retained-test-data.test.js`

- [ ] **步骤 1：编写验证器成功和失败测试**

```js
test('验证器确认账号、组织、工单和绩效样本完整', async () => {
  const source = await migratedFixtureDatabase();
  const result = await verifyRetainedTestData({ source, password: 'runtime-secret' });
  assert.equal(result.ok, true);
  assert.equal(result.accounts.active, 7);
  assert.equal(result.accounts.loginVerified, 7);
  assert.equal(result.organization.managedBySupervisor, 6);
  assert.ok(result.mockTickets.completedPerWorker.every(count => count >= 5));
  assert.equal(result.problems.length, 0);
});

test('验证器报告未停用账号和不完整绩效样本', async () => {
  const source = await migratedFixtureDatabase();
  await mutateDatabase(source, db => {
    db.run("UPDATE users SET status='active' WHERE phone='13900000000'");
    db.run("DELETE FROM tickets WHERE id LIKE 'MOCK-E2E-02-DONE-%'");
  });
  const result = await verifyRetainedTestData({ source, password: 'runtime-secret' });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(problem => problem.code === 'UNEXPECTED_ACTIVE_ACCOUNT'));
  assert.ok(result.problems.some(problem => problem.code === 'INSUFFICIENT_PERFORMANCE_SAMPLE'));
});
```

- [ ] **步骤 2：运行测试确认模块缺失**

运行：`node --test test/verify-retained-test-data.test.js`

预期：FAIL，验证器模块不存在。

- [ ] **步骤 3：实现只读验证器**

验证器读取文件但绝不写入，检查：

- 7 个手机号、角色、active 状态和 bcrypt 密码；
- active 用户数恰好为 7，其他账号均 disabled；
- active 档案数恰好为 7，6 个下属归主管；
- 小区成员范围正确；
- 每名普通人员至少 5 张完成工单和 1 张当前工单；
- 指定状态、紧急、复发、多人反馈、多小区和活动日志存在；
- 所有模拟工单都有绩效规则版本；
- 输出只包含计数和问题代码，不输出密码、哈希、JWT 或密钥。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/verify-retained-test-data.test.js`

预期：成功和失败诊断测试 PASS。

- [ ] **步骤 5：提交本任务**

```bash
git add scripts/verify-retained-test-data.js test/verify-retained-test-data.test.js
git commit -m "test: verify retained account end to end data"
```

### 任务 8：增加命令入口和运行文档

**文件：**
- 修改：`package.json`
- 修改：`README.md`
- 修改：`docs/SECURITY-AUDIT.md`
- 修改：`docs/API.md`
- 修改：`docs/superpowers/specs/2026-08-12-retained-test-accounts-and-mock-data-design.md`

- [ ] **步骤 1：编写命令和文档契约失败测试**

在 `test/prepare-retained-test-data.test.js` 增加：

```js
test('package 暴露预演、执行和验证命令且文档不含明文密码', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['retained:dry-run'], 'node scripts/prepare-retained-test-data.js');
  assert.equal(pkg.scripts['retained:apply'], 'node scripts/prepare-retained-test-data.js --apply --confirm=RETAINED-TEST-DATA');
  assert.equal(pkg.scripts['retained:verify'], 'node scripts/verify-retained-test-data.js');
  const docs = [
    fs.readFileSync('README.md', 'utf8'),
    fs.readFileSync('docs/SECURITY-AUDIT.md', 'utf8'),
    fs.readFileSync('docs/superpowers/specs/2026-08-12-retained-test-accounts-and-mock-data-design.md', 'utf8'),
  ].join('\n');
  assert.doesNotMatch(docs, /RETAINED_TEST_PASSWORD\s*=\s*\S+/);
  assert.match(docs, /RETAINED_TEST_PASSWORD/);
});
```

- [ ] **步骤 2：运行测试确认命令缺失或文档仍含明文**

运行：`node --test test/prepare-retained-test-data.test.js`

预期：FAIL，scripts 键缺失或检测到密码明文。

- [ ] **步骤 3：修改命令和文档**

`package.json` 新增：

```json
{
  "retained:dry-run": "node scripts/prepare-retained-test-data.js",
  "retained:apply": "node scripts/prepare-retained-test-data.js --apply --confirm=RETAINED-TEST-DATA",
  "retained:verify": "node scripts/verify-retained-test-data.js"
}
```

文档提供以下安全流程，但密码仅以 shell 占位说明表达，不记录实际值：

```bash
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:dry-run -- --source=/absolute/path/to/data.db
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:apply -- --source=/absolute/path/to/data.db
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:verify -- --source=/absolute/path/to/data.db
```

- [ ] **步骤 4：运行文档契约与全量测试**

运行：

```bash
node --test test/prepare-retained-test-data.test.js
npm test
git diff --check
```

预期：所有测试 PASS，`git diff --check` 无输出。

- [ ] **步骤 5：提交本任务**

```bash
git add package.json README.md docs/SECURITY-AUDIT.md docs/API.md docs/superpowers/specs/2026-08-12-retained-test-accounts-and-mock-data-design.md test/prepare-retained-test-data.test.js
git commit -m "docs: document retained account migration workflow"
```

### 任务 9：在临时副本执行两次迁移和恢复演练

**文件：**
- 不修改生产文件；只生成 `/tmp` 演练数据库和日志摘要。

- [ ] **步骤 1：复制当前数据库到明确的临时路径**

运行：

```bash
cp /Users/yellow/Desktop/工单系统/server/data.db /tmp/property-oa-retained-e2e.db
```

预期：源文件不变，临时副本存在。

- [ ] **步骤 2：执行 dry-run**

运行：

```bash
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:dry-run -- --source=/tmp/property-oa-retained-e2e.db
```

预期：输出 `mode: dry-run`、保留 7 个账号和模拟数据计划，文件 SHA-256 不变。

- [ ] **步骤 3：执行 apply 和验证**

运行：

```bash
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:apply -- --source=/tmp/property-oa-retained-e2e.db
RETAINED_TEST_PASSWORD='<运行时输入>' npm run retained:verify -- --source=/tmp/property-oa-retained-e2e.db
```

预期：生成 `.before-retained-*.db` 备份，验证输出 `ok: true`。

- [ ] **步骤 4：第二次 apply 验证幂等**

运行相同 apply/verify 命令，比较首次和第二次的表记录数。

预期：第二次不新增账号、档案、成员、模板、排班、工单或活动；所有记录数稳定。

- [ ] **步骤 5：只读恢复验证**

对首次备份运行 `npm run retained:verify`，预期验证失败但备份能被正常打开且原始表计数与执行前摘要一致；不覆盖当前工作区 `data.db`。

### 任务 10：线上备份、迁移、上传和部署验证

**文件：**
- 不在 Git 中保存线上数据库、密码、服务端密钥或迁移输出。

- [ ] **步骤 1：冻结写入并获取两份线上备份**

在 Render 控制台暂停人工写入；分别获取：

- Render `/var/data/data.db`；
- Supabase `production/data.db`。

对两份文件运行现有 `services/database-inspection.js` 摘要，记录 SHA-256 和表计数到不提交 Git 的临时目录。

- [ ] **步骤 2：确定候选主库**

若两份哈希和表计数一致，任一份均可作为候选；若不一致，以冻结写入后从 Render `/var/data/data.db` 获取的最新副本为候选，并保留 Supabase 原快照作为第二回滚点。

- [ ] **步骤 3：在候选副本执行 dry-run、apply 和 verify**

使用任务 8 的三个命令，预期 verify 返回 `ok: true`。不得直接对当前本地开发 `data.db` 执行线上 apply。

- [ ] **步骤 4：部署已通过 177 项测试的安全代码**

提交并推送本轮代码，等待 Render 构建成功；部署前保持 `SEED_WORKFORCE_DEMO=false`，避免旧 3 账号种子参与生产启动。

- [ ] **步骤 5：原子替换 Render 数据并同步 Supabase**

在 Render Shell 用迁移后的候选数据库替换 `/var/data/data.db`，重启服务；随后使用：

```bash
node scripts/migrate-sqlite-to-supabase.js --source=/var/data/data.db --confirm
npm run verify:supabase
```

预期：Supabase 和 Render 数据库 SHA-256、表集合和各表记录数一致。

- [ ] **步骤 6：线上逐账号和权限验证**

逐一验证 7 个账号：登录成功、角色正确、个人页面/日历/报告有数据；普通人员不能访问管理工作台或跨小区工单。验证一个停用账号无法登录，旧 JWT 返回 401。

- [ ] **步骤 7：重启恢复与回滚点验证**

重启 Render，确认 7 个账号、模拟工单、排班和报告仍在；将 `SUPABASE_SYNC_REQUIRED=true` 后再重启一次，确认远程快照可恢复。保留执行前 Render 和 Supabase 两份备份，直到用户验收完成。

## 最终验证命令

```bash
node --test test/retained-test-data.test.js
node --test test/prepare-retained-test-data.test.js
node --test test/verify-retained-test-data.test.js
npm test
git diff --check
```

预期：新增专项测试全部通过；现有 177 项全量测试及新增测试全部通过；diff 检查无空白错误；临时副本连续迁移两次记录数稳定。
