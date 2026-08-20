const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicRoot = path.join(__dirname, '..', 'public');

function readPublic(relativePath) {
  const filePath = path.join(publicRoot, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function loadBrowserScript(relativePath, overrides = {}) {
  const source = readPublic(relativePath);
  assert.notEqual(source, '', `${relativePath} should exist`);
  const listeners = {};
  const context = {
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    document: {
      readyState: 'loading',
      addEventListener(type, listener) { listeners[type] = listener; },
      getElementById() { return null; },
      createElement() {
        return {
          append() {},
          appendChild() {},
          addEventListener() {},
          classList: { add() {}, remove() {} },
          dataset: {},
          style: {},
          textContent: '',
        };
      },
    },
    location: {
      href: '',
      replacedWith: '',
      assign(url) { this.href = url; },
      replace(url) { this.replacedWith = url; },
    },
    window: {},
    ...overrides,
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: relativePath });
  return { context, listeners };
}

function createPlatformAdminDocument() {
  const listeners = {};
  function element() {
    return {
      attributes: {},
      children: [],
      className: '',
      disabled: false,
      listeners: {},
      textContent: '',
      value: '',
      addEventListener(type, listener) { this.listeners[type] = listener; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); return child; },
      close() {},
      reportValidity() { return true; },
      replaceChildren(...children) {
        this.children = children.flatMap((child) => child && child.isFragment ? child.children : [child]);
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      showModal() {},
    };
  }

  function tenantRow() {
    const fields = {
      nameInput: element(),
      limitInput: element(),
      activeStaffCount: element(),
      status: element(),
      saveButton: element(),
      message: element(),
    };
    const selectors = {
      '[name="name"]': fields.nameInput,
      '[name="staffLimit"]': fields.limitInput,
      '[data-field="activeStaffCount"]': fields.activeStaffCount,
      '[data-field="status"]': fields.status,
      '[data-action="save"]': fields.saveButton,
      '[data-field="message"]': fields.message,
    };
    return { fields, querySelector(selector) { return selectors[selector] || null; } };
  }

  const elements = {
    'platform-admin-status': element(),
    'platform-logout': element(),
    'platform-refresh': element(),
    'platform-overview-cards': element(),
    'platform-applications-body': element(),
    'platform-tenants-body': element(),
    'platform-audit-body': element(),
    'approval-form': element(),
    'approval-dialog': element(),
    'approval-cancel': element(),
    'approval-submit': element(),
    'approval-status': element(),
    'approval-staff-limit': element(),
    'tenant-row-template': {
      content: { firstElementChild: { cloneNode() { return tenantRow(); } } },
    },
  };
  return {
    elements,
    listeners,
    document: {
      readyState: 'loading',
      addEventListener(type, listener) { listeners[type] = listener; },
      createDocumentFragment() {
        const fragment = element();
        fragment.isFragment = true;
        return fragment;
      },
      createElement() { return element(); },
      getElementById(id) { return elements[id] || null; },
    },
  };
}

async function settleAsyncRendering() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('平台与申请页面使用独立脚本且系统标题固定', () => {
  const platformLogin = readPublic('platform-login.html');
  const platformAdmin = readPublic('platform-admin.html');
  const enterpriseApply = readPublic('enterprise-apply.html');

  assert.match(platformLogin, /<title>平台运维登录 \| 工单系统<\/title>/);
  assert.match(platformLogin, /js\/platform-login\.js/);
  assert.match(platformAdmin, /<title>平台运维后台 \| 工单系统<\/title>/);
  assert.match(platformAdmin, /js\/platform-admin\.js/);
  assert.match(enterpriseApply, /<title>申请企业主管账号 \| 工单系统<\/title>/);
  assert.match(enterpriseApply, /js\/enterprise-apply\.js/);
  assert.doesNotMatch(platformLogin + platformAdmin + enterpriseApply, /全流程测试小区工单系统/);
});

test('企业登录页开放企业主管申请链接但企业导航不暴露平台入口', () => {
  const index = readPublic('index.html');
  assert.match(index, /href="\/enterprise-apply\.html"[^>]*>申请企业主管账号/);
  const nav = index.match(/<nav class="nav">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.doesNotMatch(nav, /platform|平台运维/);
  assert.equal(index.match(/<title>([^<]+)<\/title>/)?.[1], '工单系统');
  assert.doesNotMatch(readPublic('app.js'), /name\s*\+\s*['"]工单系统/);
});

test('企业申请提交精确 payload，成功后清空并提示待审核', async () => {
  assert.match(readPublic('enterprise-apply.html'), /id="confirm"\s+name="confirm"/);
  const requests = [];
  const storageCalls = [];
  const { context } = loadBrowserScript('js/enterprise-apply.js', {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 201, json: async () => ({ data: { id: 'application-1' } }) };
    },
    localStorage: { setItem(...args) { storageCalls.push(['local', ...args]); } },
    sessionStorage: { setItem(...args) { storageCalls.push(['session', ...args]); } },
  });
  const fields = {
    enterpriseName: { value: '安居物业' },
    supervisorName: { value: '李主管' },
    phone: { value: '13800138000' },
    password: { value: 'Secret-123' },
    confirm: { value: 'Secret-123' },
  };
  const form = { elements: fields, resetCalled: false, reset() { this.resetCalled = true; } };
  const status = { textContent: '', className: '' };
  const button = { disabled: false };

  await context.EnterpriseApply.submitApplication(form, status, button);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/enterprise-applications');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    enterpriseName: '安居物业',
    supervisorName: '李主管',
    phone: '13800138000',
    password: 'Secret-123',
  });
  assert.equal(form.resetCalled, true);
  assert.match(status.textContent, /待审核/);
  assert.deepEqual(storageCalls, []);
  assert.equal(button.disabled, false);
});

test('企业申请会校验确认密码并阻止重复提交', async () => {
  assert.doesNotMatch(readPublic('js/enterprise-apply.js'), /confirmPassword/);
  let fetchCount = 0;
  let resolveFetch;
  const { context } = loadBrowserScript('js/enterprise-apply.js', {
    fetch: () => {
      fetchCount += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    localStorage: {},
    sessionStorage: {},
  });
  const fields = {
    enterpriseName: { value: '安居物业' },
    supervisorName: { value: '李主管' },
    phone: { value: '13800138000' },
    password: { value: 'Secret-123' },
    confirm: { value: 'Secret-123' },
  };
  const form = { elements: fields, reset() {} };
  const status = { textContent: '', className: '' };
  const button = { disabled: false };

  const first = context.EnterpriseApply.submitApplication(form, status, button);
  const second = context.EnterpriseApply.submitApplication(form, status, button);
  assert.equal(button.disabled, true);
  assert.equal(fetchCount, 1);
  resolveFetch({ ok: true, status: 201, json: async () => ({ data: {} }) });
  await Promise.all([first, second]);
  assert.equal(button.disabled, false);

  fields.confirm.value = 'different';
  await context.EnterpriseApply.submitApplication(form, status, button);
  assert.equal(fetchCount, 1);
  assert.match(status.textContent, /两次输入的密码不一致/);
});

test('平台登录只使用 sessionStorage.platform_token', async () => {
  const session = new Map();
  const localWrites = [];
  const requests = [];
  const { context } = loadBrowserScript('js/platform-login.js', {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ token: 'platform-secret' }) };
    },
    sessionStorage: {
      getItem(key) { return session.get(key) || null; },
      setItem(key, value) { session.set(key, value); },
    },
    localStorage: { setItem(...args) { localWrites.push(args); } },
  });
  const form = { elements: { phone: { value: '13800138000' }, password: { value: 'secret' } } };
  const status = { textContent: '', className: '' };
  const button = { disabled: false };

  await context.PlatformLogin.login(form, status, button);

  assert.equal(requests[0].url, '/api/platform/login');
  assert.deepEqual(JSON.parse(requests[0].options.body), { phone: '13800138000', password: 'secret' });
  assert.equal(session.get('platform_token'), 'platform-secret');
  assert.equal(session.has('token'), false);
  assert.deepEqual(localWrites, []);
  assert.equal(context.location.href, '/platform-admin.html');
});

test('平台后台提供四个限定运维区域', () => {
  const html = readPublic('platform-admin.html');
  for (const section of ['overview', 'applications', 'tenants', 'audit']) {
    assert.match(html, new RegExp(`data-section="${section}"`));
  }
  assert.match(html, /总览/);
  assert.match(html, /企业\/主管申请/);
  assert.match(html, /企业列表与配置/);
  assert.match(html, /平台审计日志/);
  assert.doesNotMatch(html, /工单详情|人员手机号|员工手机号/);
});

test('人数上限输入与审批弹窗均约束 1–999，审批默认 4', () => {
  const html = readPublic('platform-admin.html');
  assert.match(html, /name="staffLimit"[^>]*min="1"[^>]*max="999"[^>]*step="1"/);
  assert.match(html, /id="approval-staff-limit"[^>]*value="4"[^>]*min="1"[^>]*max="999"[^>]*step="1"/);
});

test('平台 API 客户端携带独立 token，并在 401/403 时清理后 replace 跳转', async () => {
  for (const statusCode of [401, 403]) {
    const session = new Map([['platform_token', 'platform-token']]);
    const requests = [];
    const { context } = loadBrowserScript('js/platform-admin.js', {
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: false, status: statusCode, json: async () => ({ error: 'raw backend detail' }) };
      },
      sessionStorage: {
        getItem(key) { return session.get(key) || null; },
        removeItem(key) { session.delete(key); },
      },
    });

    await assert.rejects(context.PlatformAdmin.apiFetch('/api/platform/overview'));
    assert.equal(requests[0].options.headers.Authorization, 'Bearer platform-token');
    assert.equal(session.has('platform_token'), false);
    assert.equal(context.location.replacedWith, '/platform-login.html');
    assert.equal(context.location.href, '');
  }
});

test('平台修改、审批和拒绝发送精确 payload', async () => {
  const requests = [];
  const { context } = loadBrowserScript('js/platform-admin.js', {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    },
    sessionStorage: { getItem() { return 'platform-token'; }, removeItem() {} },
  });

  await context.PlatformAdmin.updateTenant('tenant/a', '新企业', 12);
  await context.PlatformAdmin.approveApplication('application/a', 4);
  await context.PlatformAdmin.rejectApplication('application/a', '资料不完整');

  assert.deepEqual(requests.map(({ url, options }) => [url, options.method, JSON.parse(options.body)]), [
    ['/api/platform/tenants/tenant%2Fa', 'PATCH', { name: '新企业', staffLimit: 12 }],
    ['/api/platform/applications/application%2Fa/approve', 'POST', { staffLimit: 4 }],
    ['/api/platform/applications/application%2Fa/reject', 'POST', { reason: '资料不完整' }],
  ]);
});

test('人数上限低于在职人数时显示中文错误并保留用户输入', async () => {
  const { context } = loadBrowserScript('js/platform-admin.js', {
    fetch: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ code: 'STAFF_LIMIT_BELOW_ACTIVE_COUNT' }),
    }),
    sessionStorage: { getItem() { return 'platform-token'; }, removeItem() {} },
  });
  assert.equal(typeof context.PlatformAdmin.saveTenantChanges, 'function');
  const controls = {
    nameInput: { value: '用户输入的新企业名' },
    limitInput: { value: '2' },
    message: { textContent: '', className: '' },
    button: { disabled: false },
  };

  const saved = await context.PlatformAdmin.saveTenantChanges({ id: 'tenant-1' }, controls);

  assert.equal(saved, false);
  assert.equal(controls.nameInput.value, '用户输入的新企业名');
  assert.equal(controls.limitInput.value, '2');
  assert.match(controls.message.textContent, /人数上限不能低于当前在职人数/);
  assert.equal(controls.button.disabled, false);
});

test('企业列表真实渲染路径禁用缺失或非法必需字段的行', async () => {
  const fixture = createPlatformAdminDocument();
  const malformedTenants = [
    { id: 'missing-limit', name: '缺少上限企业', active_staff_count: 0, status: 'active' },
    { id: '', name: '缺少编号企业', staff_limit: 4, active_staff_count: 0, status: 'active' },
    { id: 'blank-name', name: '   ', staff_limit: 4, active_staff_count: 0, status: 'active' },
    { id: 'decimal-limit', name: '小数上限企业', staff_limit: 2.5, active_staff_count: 0, status: 'active' },
    { id: 'too-large-limit', name: '越界上限企业', staff_limit: 1000, active_staff_count: 0, status: 'active' },
  ];
  loadBrowserScript('js/platform-admin.js', {
    document: fixture.document,
    fetch: async (url) => {
      if (url === '/api/platform/tenants') return { ok: true, status: 200, json: async () => ({ data: malformedTenants }) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    },
    sessionStorage: { getItem() { return 'platform-token'; }, removeItem() {} },
  });

  fixture.listeners.DOMContentLoaded();
  await settleAsyncRendering();

  const rows = fixture.elements['platform-tenants-body'].children;
  assert.equal(rows.length, malformedTenants.length);
  for (const row of rows) {
    assert.equal(row.fields.saveButton.disabled, true);
    assert.equal(row.fields.saveButton.listeners.click, undefined);
    assert.match(row.fields.message.textContent, /企业数据不完整，暂不能编辑/);
  }
  assert.notEqual(rows[0].fields.limitInput.value, '1');
});

test('企业列表真实渲染路径为编辑输入设置企业上下文可访问名称', async () => {
  const fixture = createPlatformAdminDocument();
  loadBrowserScript('js/platform-admin.js', {
    document: fixture.document,
    fetch: async (url) => {
      if (url === '/api/platform/tenants') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'tenant-1', name: '安居物业', staff_limit: 8, active_staff_count: 3, status: 'active' }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    },
    sessionStorage: { getItem() { return 'platform-token'; }, removeItem() {} },
  });

  fixture.listeners.DOMContentLoaded();
  await settleAsyncRendering();

  const row = fixture.elements['platform-tenants-body'].children[0];
  assert.match(row.fields.nameInput.getAttribute('aria-label'), /安居物业.*企业名称/);
  assert.match(row.fields.limitInput.getAttribute('aria-label'), /安居物业.*总人数上限/);
});

test('平台脚本安全构建外部文本、处理人数下限错误并防重复提交', async () => {
  const script = readPublic('js/platform-admin.js');
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(script, /textContent\s*=/);
  assert.match(script, /STAFF_LIMIT_BELOW_ACTIVE_COUNT/);
  assert.match(script, /人数上限不能低于当前在职人数/);

  const { context } = loadBrowserScript('js/platform-admin.js', {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }),
    sessionStorage: { getItem() { return 'platform-token'; }, removeItem() {} },
  });
  let calls = 0;
  let finish;
  const button = { disabled: false };
  const task = () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  };

  const first = context.PlatformAdmin.withSubmitLock(button, task);
  const second = context.PlatformAdmin.withSubmitLock(button, task);
  assert.equal(button.disabled, true);
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(button.disabled, false);
});
