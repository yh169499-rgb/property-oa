const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFullTestDB,
  seedTenant,
  tenantServer,
} = require('./helpers/tenant-fixture');
const { authHeader } = require('./helpers/auth');
const config = require('../config');
const { one } = require('./helpers/tenant-fixture');
const {
  getTenantAlertConfig,
  sendTicketAlert,
  setMessageSenderForTests,
  resetMessageSenderForTests,
} = require('../services/jzm-messaging');

const SUPERVISOR = { id: 1, name: '主管', role: '主管', tenant_id: 'tenant-a' };

async function fixture() {
  const db = await createFullTestDB();
  db.run(`INSERT INTO users (id, phone, password, name, role, status) VALUES
    (1, '13800000001', 'x', '主管', '主管', 'active'),
    (2, '13800000002', 'x', '张师傅', 'worker', 'active')`);
  db.run(`INSERT INTO staff_profiles
    (id, user_id, name, position, manager_id, employment_status, created_at, updated_at) VALUES
    (1, 1, '主管', '主管', NULL, 'active', '2026-01-01', '2026-01-01'),
    (2, 2, '张师傅', '维修师傅', 1, 'active', '2026-01-01', '2026-01-01')`);
  db.run(`INSERT INTO communities (id, name, created) VALUES ('c1', '测试小区', '2026-01-01')`);
  seedTenant(db, { id: 'tenant-a', name: '测试企业' });
  db.run(`INSERT INTO community_memberships (tenant_id, community_id, staff_profile_id, created_at)
    VALUES ('tenant-a', 'c1', 1, '2026-01-01'), ('tenant-a', 'c1', 2, '2026-01-01')`);
  return db;
}

async function request(server, path, user, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: { ...(user ? authHeader(user) : {}), ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

async function configure(server) {
  return request(server, '/api/settings/jzm-alert', SUPERVISOR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId: 'room-a',
      imBotId: 'bot-a',
      managerContactId: 'manager-contact-a',
      contactMap: { '张师傅': 'worker-contact-a', '13800000002': 'worker-contact-a' },
    }),
  });
}

test('主管可保存和读取企业秒回预警配置，响应不泄露 Token', async (t) => {
  const server = await tenantServer(await fixture());
  t.after(() => server.close());
  const saved = await configure(server);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.data.roomId, 'room-a');
  assert.equal(saved.body.data.imBotId, 'bot-a');
  assert.equal(saved.body.data.contactCount, 2);
  assert.equal(Object.hasOwn(saved.body.data, 'msgToken'), false);

  const loaded = await request(server, '/api/settings/jzm-alert', SUPERVISOR);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.body.data.managerContactIdConfigured, true);
});

test('创建工单按是否派单选择主管或处理人进行提醒', async (t) => {
  const calls = [];
  setMessageSenderForTests(async (input) => { calls.push(input); return { success: true }; });
  t.after(() => resetMessageSenderForTests());
  const server = await tenantServer(await fixture());
  t.after(() => server.close());
  await configure(server);

  const unassigned = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'repair', cat: '水暖', desc: '漏水', loc: '3号楼', message: '水管爆裂', community_id: 'c1' }),
  });
  assert.equal(unassigned.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1).body.imRoomId, 'room-a');
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, ['manager-contact-a']);
  assert.match(calls.at(-1).body.payload.text, /紧急消息提醒/);

  const assigned = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'repair', cat: '电路', desc: '跳闸', loc: '2号楼', message: '配电箱跳闸', worker: '张师傅', status: 'doing', community_id: 'c1' }),
  });
  assert.equal(assigned.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, ['worker-contact-a']);
});

test('派单和完工会分别发送处理人提醒与完工提醒', async (t) => {
  const calls = [];
  setMessageSenderForTests(async (input) => { calls.push(input); return { success: true }; });
  t.after(() => resetMessageSenderForTests());
  const server = await tenantServer(await fixture());
  t.after(() => server.close());
  await configure(server);

  const created = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'repair', cat: '门窗', desc: '门锁损坏', loc: '1号楼', message: '请处理', community_id: 'c1' }),
  });
  const id = created.body.record.id;
  await new Promise((resolve) => setImmediate(resolve));
  const assigned = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worker: '张师傅', status: 'doing' }),
  });
  assert.equal(assigned.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, ['worker-contact-a']);

  const submitted = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'confirm' }),
  });
  assert.equal(submitted.response.status, 200);
  const completed = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', finished: '2026-07-19T06:56:44.000Z' }),
  });
  assert.equal(completed.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(calls.at(-1).body.payload.text, /工单完结提醒/);
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, ['worker-contact-a']);
});

test('主管待派单提醒发送到企业固定预警群并@主管', async (t) => {
  const calls = [];
  setMessageSenderForTests(async (input) => { calls.push(input); return { success: true }; });
  t.after(() => resetMessageSenderForTests());
  const server = await tenantServer(await fixture());
  t.after(() => server.close());
  await configure(server);
  const created = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'help', cat: '咨询', desc: '需要帮助', loc: '大厅', community_id: 'c1' }),
  });
  assert.equal(created.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const result = await request(server, '/api/reminder/trigger', SUPERVISOR);
  assert.equal(result.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(calls.at(-1).body.payload.text, /当前还有 1 张工单待派单/);
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, ['manager-contact-a']);
});

test('未配置企业不回退到其他企业群或联系人，缺失处理人映射不降级@主管', async (t) => {
  const calls = [];
  setMessageSenderForTests(async (input) => { calls.push(input); return { success: true }; });
  t.after(() => resetMessageSenderForTests());
  const db = await fixture();
  const server = await tenantServer(db);
  t.after(() => server.close());
  await configure(server);

  const tenantB = getTenantAlertConfig(db, 'tenant-b');
  assert.equal(tenantB.roomId, '');
  assert.equal(tenantB.managerContactId, '');
  assert.deepEqual(tenantB.contactMap, {});
  await sendTicketAlert({
    db, tenantId: 'tenant-b', kind: 'created',
    ticket: { id: 'WB-1', cat: '水暖', message: 'B 企业工单', created: '2026-08-24T00:00:00Z' },
    assignee: null,
  });
  assert.equal(calls.at(-1).body.imRoomId, '');
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, []);

  await sendTicketAlert({
    db, tenantId: 'tenant-a', kind: 'assigned',
    ticket: { id: 'WA-1', cat: '电路', worker: '未配置师傅', message: '不应@主管' },
    assignee: { displayName: '未配置师傅' },
  });
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, []);
});

test('外部建单按企业名称归属租户并触发该企业预警', async (t) => {
  const calls = [];
  setMessageSenderForTests(async (input) => { calls.push(input); return { success: true }; });
  t.after(() => resetMessageSenderForTests());
  const db = await fixture();
  const server = await tenantServer(db, undefined, { id: 'tenant-a', name: '测试企业' });
  t.after(() => server.close());
  const previousToken = config.JZMM_INGEST_TOKEN;
  config.JZMM_INGEST_TOKEN = 'integration-test-token';
  t.after(() => { config.JZMM_INGEST_TOKEN = previousToken; });

  const result = await request(server, '/api/tickets/external', null, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-JZM-Ingest-Token': 'integration-test-token',
    },
    body: JSON.stringify({
      enterprise_name: '测试企业',
      roomid: 'room-a', imbotid: 'bot-a', contactid: 'manager-contact-a',
      type: 'repair', cat: '水暖', desc: '3号楼漏水', loc: '3号楼',
      message: '请尽快处理', community_name: '测试小区',
      status: 'done', worker: '不应由外部接口指定',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.record.status, 'wait');
  assert.equal(result.body.record.worker, null);
  const stored = one(db, 'SELECT tenant_id,status,worker FROM tickets WHERE id = ?', [result.body.record.id]);
  assert.deepEqual(stored, { tenant_id: 'tenant-a', status: 'wait', worker: '' });
  assert.equal(getTenantAlertConfig(db, 'tenant-a').roomId, 'room-a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1).body.imRoomId, 'room-a');
  assert.deepEqual(calls.at(-1).body.payload.mentionContactIds, ['manager-contact-a']);
});

test('外部建单拒绝错误令牌和未知企业', async (t) => {
  const server = await tenantServer(await fixture(), undefined, { id: 'tenant-a', name: '测试企业' });
  t.after(() => server.close());
  const previousToken = config.JZMM_INGEST_TOKEN;
  config.JZMM_INGEST_TOKEN = 'integration-test-token';
  t.after(() => { config.JZMM_INGEST_TOKEN = previousToken; });
  const base = { type: 'repair', cat: '水暖', desc: '漏水', loc: '3号楼', message: '请处理', community_name: '测试小区' };
  const unauthorized = await request(server, '/api/tickets/external', null, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JZM-Ingest-Token': 'bad' },
    body: JSON.stringify({ ...base, enterprise_name: '测试企业' }),
  });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.code, 'INVALID_INTEGRATION_TOKEN');
  const unknown = await request(server, '/api/tickets/external', null, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JZM-Ingest-Token': 'integration-test-token' },
    body: JSON.stringify({ ...base, enterprise_name: '不存在企业' }),
  });
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.code, 'ENTERPRISE_NOT_FOUND');
});
