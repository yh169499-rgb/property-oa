# 管理平台数据中心实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将平台运维入口统一更名为“管理平台”，并增加平台管理员按企业查看和安全编辑业务数据的数据中心，禁止删除和敏感字段泄露。

**架构：** 在 `/api/platform` 下增加固定表/字段白名单服务，所有查询和更新都通过租户条件、参数化 SQL 和平台管理员鉴权；前端在现有管理平台增加“数据中心”导航、企业选择、表目录、分页表格和编辑弹窗。每次编辑写入现有 `platform_audit_logs`，不新增删除接口。

**技术栈：** Express 4、sql.js、SQLite 参数化查询、原生 HTML/CSS/JavaScript、Node `node:test`。

---

## 文件结构与职责

- 创建：`services/platform-data-center.js` — 数据表目录、查询投影、分页、字段白名单、编辑校验和审计写入。
- 修改：`routes/platform.js` — 注册数据中心目录、查询和 PATCH 路由，仅复用 `requirePlatformOwner`。
- 创建：`test/platform-data-center.test.js` — 服务层和路由安全、分页、编辑、审计、禁止删除测试。
- 修改：`public/platform-login.html` — 登录页文案改为“管理平台”。
- 修改：`public/platform-admin.html` — 标题、导航和数据中心容器改为“管理平台”，增加企业/表/分页/编辑 UI 容器。
- 修改：`public/js/platform-admin.js` — 数据中心 API 调用、表格渲染、编辑弹窗、无删除交互。
- 修改：`public/styles.css` — 数据中心筛选栏、横向表格、分页和编辑弹窗样式。
- 修改：`test/platform-ui.test.js` — 文案、数据中心 DOM 和前端调用静态测试。
- 修改：`docs/API.md` — 补充平台数据中心接口、字段限制和错误码。

### 任务 1：先写数据中心安全测试

**文件：**
- 创建：`test/platform-data-center.test.js`
- 参考：`test/platform-tenants.test.js` 的 sql.js fixture、`test/helpers/tenant-fixture.js` 的多租户数据构造方式。

- [ ] **步骤 1：编写失败测试，覆盖平台权限和表白名单**

```js
test('只有无租户的平台管理员可以读取企业数据目录和分页数据', async (t) => {
  const { server } = await fixture(t);
  const owner = authHeader({ id: 900, role: 'platform_owner', tenant_id: '' });
  const supervisor = authHeader({ id: 1, role: '主管', tenant_id: 'tenant-a' });

  const catalog = await request(server, '/api/platform/tenants/tenant-a/data-tables', { headers: owner });
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.data.some((table) => table.key === 'tickets'));

  const rows = await request(server, '/api/platform/tenants/tenant-a/data/tickets?page=1&pageSize=2', { headers: owner });
  assert.equal(rows.status, 200);
  assert.ok(rows.body.data.rows.length <= 2);
  assert.equal(JSON.stringify(rows.body), rows.body.data.rows.some((row) => row.password) ? 'forbidden' : JSON.stringify(rows.body));

  assert.equal((await request(server, '/api/platform/tenants/tenant-a/data-tables', { headers: supervisor })).status, 403);
});

test('未知表、敏感字段和 DELETE 均被拒绝', async (t) => {
  const { server } = await fixture(t);
  const owner = authHeader({ id: 900, role: 'platform_owner', tenant_id: '' });
  assert.equal((await request(server, '/api/platform/tenants/tenant-a/data/users/password', { headers: owner })).status, 404);
  assert.equal((await request(server, '/api/platform/tenants/tenant-a/data/unknown', { headers: owner })).status, 404);
  assert.equal((await request(server, '/api/platform/tenants/tenant-a/data/tickets/1', { method: 'DELETE', headers: owner })).status, 405);
});
```

这里的 `fixture` 插入两个租户、一个平台管理员、人员、工单和密码字段；断言使用公开响应内容检查敏感字段没有出现。

- [ ] **步骤 2：运行测试确认接口尚不存在**

运行：`node --test test/platform-data-center.test.js`

预期：失败，路由返回 404 或导入的服务函数不存在。

### 任务 2：实现数据中心服务层

**文件：**
- 创建：`services/platform-data-center.js`
- 测试：`test/platform-data-center.test.js`

- [ ] **步骤 1：定义固定表描述和字段策略**

实现 `TABLES` 映射，每项至少包含 `key`、`label`、`idColumn`、`columns`、`searchColumns`、`sortColumns`、`editable`、`readOnly`。只允许规格中列出的企业表；`community_permissions` 和 `community_memberships` 使用复合键只读；用户密码、注册密码、会话版本、租户归属和密钥配置不进入 `columns`。

- [ ] **步骤 2：实现企业和输入校验**

实现以下函数，并在所有公共函数入口调用：

```js
function assertPlatformDataAccess(db, actor, tenantId) {}
function tableDescriptor(tableKey) {}
function tenantOrThrow(db, tenantId) {}
function parsePageOptions(query, descriptor) {}
```

`assertPlatformDataAccess` 要求 `actor.role === 'platform_owner'` 且 `actor.tenant_id` 为空；`tableDescriptor` 对未知表抛出 `PLATFORM_DATA_TABLE_NOT_FOUND`；排序和搜索字段只能从描述中选择。

- [ ] **步骤 3：实现分页查询和安全投影**

实现 `listDataTables(db, actor, tenantId)` 与 `listDataRows(db, actor, tenantId, tableKey, options)`。表名、列名来自服务端映射，值使用 `?` 参数；所有租户表查询必须带 `tenant_id = ?`。返回 `{ columns, rows, page, pageSize, total }`，不返回密码、哈希、JWT、密钥或服务端配置值。

- [ ] **步骤 4：实现安全编辑和审计**

实现 `updateDataRow(db, actor, tenantId, tableKey, rowId, patch)`：拒绝空 patch、非白名单字段、主键/租户字段、敏感字段和只读表；读取 `before`，执行参数化 UPDATE，读取 `after`，写入 `platform_audit_logs.action='data.update'`。对 `users` 与 `staff_profiles` 的姓名、手机号、在职状态更新在同一事务内同步，手机号重复返回 `PHONE_CONFLICT`；停用账号时增加 `session_version`，保留历史档案。

- [ ] **步骤 5：运行服务层测试确认通过**

运行：`node --test test/platform-data-center.test.js`

预期：目录、租户过滤、敏感字段、编辑同步、审计和禁止删除相关测试全部通过。

- [ ] **步骤 6：提交后端服务层**

```bash
git add services/platform-data-center.js test/platform-data-center.test.js
git commit -m "feat: add secure platform data center service"
```

### 任务 3：接入平台 API 路由

**文件：**
- 修改：`routes/platform.js`
- 测试：`test/platform-data-center.test.js`

- [ ] **步骤 1：增加平台管理员路由**

在 `router.use(requireAuth, requirePlatformOwner)` 之后注册：

```js
router.get('/tenants/:tenantId/data-tables', ...);
router.get('/tenants/:tenantId/data/:table', ...);
router.patch('/tenants/:tenantId/data/:table/:id', ...);
router.delete('/tenants/:tenantId/data/:table/:id', (req, res) => res.status(405).json({ error: '不支持删除', code: 'PLATFORM_DATA_DELETE_FORBIDDEN' }));
```

路由只负责解析 query/body、调用服务层和 `database.saveDB()`；错误统一返回稳定 `code`，不返回 SQL、密码或异常堆栈。

- [ ] **步骤 2：增加跨租户和编辑回归测试**

测试平台管理员不能读取不存在企业、不能通过 `tenantId` 读取另一条租户数据；PATCH 人员资料、工单描述和小区名称后数据库值与审计日志一致；修改 `tenant_id`、密码、角色和 `manager_id` 返回 400/403。

- [ ] **步骤 3：运行 API 测试**

运行：`node --test test/platform-data-center.test.js test/platform-api.test.js test/tenant-auth.test.js`

预期：全部通过，普通企业账号仍只能访问原有企业接口。

- [ ] **步骤 4：提交 API**

```bash
git add routes/platform.js test/platform-data-center.test.js
git commit -m "feat: expose platform tenant data APIs"
```

### 任务 4：统一管理平台文案并增加数据中心页面

**文件：**
- 修改：`public/platform-login.html`
- 修改：`public/platform-admin.html`
- 修改：`public/js/platform-admin.js`
- 修改：`public/styles.css`
- 测试：`test/platform-ui.test.js`

- [ ] **步骤 1：先增加前端静态失败断言**

在 `test/platform-ui.test.js` 增加：

```js
assert.match(platformAdmin, /数据中心/);
assert.match(platformAdminScript, /data-tables/);
assert.match(platformAdminScript, /PATCH/);
assert.doesNotMatch(platformLogin + platformAdmin, /平台运维登录|平台运维后台|平台运维功能/);
assert.doesNotMatch(platformAdminScript, /method:\s*['"]DELETE['"]/i);
```

- [ ] **步骤 2：运行前端测试确认失败**

运行：`node --test test/platform-ui.test.js`

预期：数据中心 DOM、API 调用和新文案断言失败。

- [ ] **步骤 3：修改登录页和后台文案**

将页面标题、品牌、副标题、导航 `aria-label`、按钮和错误提示统一改为“管理平台”，保留内部 `platform_owner` 和 `/api/platform` 路径不变。

- [ ] **步骤 4：增加数据中心 DOM**

在 `platform-admin.html` 的导航增加 `#data-center`，新增企业选择器、表选择器、搜索/刷新控件、表格容器、分页控件和编辑 `dialog`。表格没有删除按钮；空数据、加载失败和权限失效分别显示明确状态。

- [ ] **步骤 5：实现数据中心脚本**

在 `platform-admin.js` 增加 `loadDataTenants`、`loadDataTables`、`loadDataRows`、`openDataEditor`、`saveDataRow`。所有请求复用已有 `apiFetch`；只渲染 API 返回的字段定义；编辑成功后刷新当前行、显示审计提示；不实现任何 `DELETE` 请求。

- [ ] **步骤 6：增加样式并运行前端测试**

增加表格横向滚动、字段类型样式、分页按钮、编辑弹窗和窄屏布局。运行：`node --test test/platform-ui.test.js test/frontend-feature.test.js`。

预期：平台 UI 测试和现有前端功能测试全部通过。

- [ ] **步骤 7：提交前端**

```bash
git add public/platform-login.html public/platform-admin.html public/js/platform-admin.js public/styles.css test/platform-ui.test.js
git commit -m "feat: add management platform data center UI"
```

### 任务 5：补充 API 文档和安全回归

**文件：**
- 修改：`docs/API.md`
- 修改：`test/security-audit.test.js`
- 测试：全量 `test/**/*.test.js`

- [ ] **步骤 1：补充接口文档**

记录三个接口的鉴权、query 参数、响应结构、可编辑字段、敏感字段、错误码和“禁止 DELETE”规则；明确平台管理员角色内部仍为 `platform_owner`。

- [ ] **步骤 2：增加安全审计断言**

验证路由源码不接受任意 SQL/表名拼接、不返回密码字段、不注册删除接口；验证平台 token 失效后数据中心请求返回 401 并清理平台会话。

- [ ] **步骤 3：运行验证命令**

```bash
node --test test/platform-data-center.test.js test/platform-api.test.js test/platform-ui.test.js test/security-audit.test.js
node --check routes/platform.js
node --check services/platform-data-center.js
node --check public/js/platform-admin.js
git diff --check
```

预期：所有测试通过、语法检查退出码为 0、差异检查无输出。

- [ ] **步骤 4：提交文档和安全测试**

```bash
git add docs/API.md test/security-audit.test.js
git commit -m "docs: document management platform data center security"
```

### 任务 6：生产前验证与部署准备

**文件：**
- 无新增文件；复核任务 2—5 的变更。

- [ ] **步骤 1：运行完整测试**

运行：`npm test`

预期：退出码为 0，失败数为 0。若沙箱阻止本地监听，使用允许本地测试端口的同一命令重跑，不跳过失败测试。

- [ ] **步骤 2：检查工作树和提交内容**

运行：`git status --short`、`git log --oneline -6`、`git diff origin/master...HEAD --stat`。

预期：只包含本规格涉及的文件，未出现 `.env`、数据库快照、密码或密钥。

- [ ] **步骤 3：提交最终集成变更**

```bash
git add docs/API.md public routes services test
git commit -m "feat: complete management platform data center"
```

部署需在用户明确授权后将提交推送到 GitHub `master`，再等待 Render 自动部署并通过线上静态资源和健康检查验证。

