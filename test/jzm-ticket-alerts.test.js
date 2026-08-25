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
  saveTenantAlertConfig,
  sendTicketAlert,
  setMessageSenderForTests,
  resetMessageSenderForTests,
} = require('../services/jzm-messaging');

const SUPERVISOR = { id: 1, name: '主管', role: '主管', tenant_id: 'tenant-a' };

async function fixture() {
  const db = await createFullTestDB();
  db.run(`INSERT INTO users (id, phone, password, name, role, status) VALUES
    (1, '13800000001', 'x', '主管', '主管', 'active'),
    (2, '13800000002', 'x', '张师傅', 'worker', 'active'),
    (3, '13800000003', 'x', '李师傅', 'worker', 'active')`);
  db.run(`INSERT INTO staff_profiles
    (id, user_id, name, position, manager_id, employment_status, created_at, updated_at) VALUES
    (1, 1, '主管', '主管', NULL, 'active', '2026-01-01', '2026-01-01'),
    (2, 2, '张师傅', '维修师傅', 1, 'active', '2026-01-01', '2026-01-01'),
    (3, 3, '李师傅', '维修师傅', 1, 'active', '2026-01-01', '2026-01-01')`);
  db.run(`INSERT INTO communities (id, name, created) VALUES ('c1', '测试小区', '2026-01-01')`);
  seedTenant(db, { id: 'tenant-a', name: '测试企业' });
  db.run(`INSERT INTO community_memberships (tenant_id, community_id, staff_profile_id, created_at)
    VALUES ('tenant-a', 'c1', 1, '2026-01-01'), ('tenant-a', 'c1', 2, '2026-01-01'),
      ('tenant-a', 'c1', 3, '2026-01-01')`);
  return db;
}

async function request(server, path, user, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: { ...(user ? authHeader(user) : {}), ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

function captureWarnings(t) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map((value) => String(value)).join(' '));
  t.after(() => { console.warn = originalWarn; });
  return warnings;
}

async function configure(server) {
  return request(server, '/api/settings/jzm-alert', SUPERVISOR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId: 'room-a',
      imBotId: 'bot-a',
      managerContactId: 'manager-contact-a',
      contactMap: {
        '张师傅': 'worker-contact-a', '13800000002': 'worker-contact-a',
        '李师傅': 'worker-contact-b',
      },
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
  assert.equal(saved.body.data.contactCount, 3);
  assert.equal(Object.hasOwn(saved.body.data, 'msgToken'), false);

  const loaded = await request(server, '/api/settings/jzm-alert', SUPERVISOR);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.body.data.managerContactIdConfigured, true);
});

test('秒回消息服务默认使用生产消息接口地址', () => {
  const configured = getTenantAlertConfig(null, 'tenant-a');
  assert.equal(configured.baseUrl, 'https://ae-bg.ddregion.com/hub-api');
});

test('Render 旧消息地址会自动迁移到生产地址', () => {
  const previous = config.JZMM_MSG_BASE_URL;
  try {
    for (const legacyUrl of [
      'https://open.dpclouds.com',
      'https://ae-mh.ddregion.com',
      'https://test-aa-hub.ddregion.com',
    ]) {
      config.JZMM_MSG_BASE_URL = legacyUrl;
      assert.equal(getTenantAlertConfig(null, 'tenant-a').baseUrl, 'https://ae-bg.ddregion.com/hub-api');
    }
  } finally {
    config.JZMM_MSG_BASE_URL = previous;
  }
});

test('秒回消息请求使用最终 hub-api 发送路径', async (t) => {
  let captured;
  setMessageSenderForTests(async (input) => {
    captured = input;
    return { success: true };
  });
  t.after(() => resetMessageSenderForTests());
  await sendTicketAlert({
    db: null,
    tenantId: 'tenant-a',
    kind: 'created',
    ticket: { id: 'WX-URL', cat: '测试', message: '路径验证' },
    actor: { name: '系统测试' },
  });
  assert.equal(captured.url, 'https://ae-bg.ddregion.com/hub-api/api/v2/message/send?token=');
});

test('文本消息使用 mention 字段原生@主管', async (t) => {
  const db = await fixture();
  saveTenantAlertConfig(db, 'tenant-a', {
    roomId: 'room-a',
    imBotId: 'bot-a',
    managerContactId: 'manager-contact-a',
    contactMap: {},
  });
  let captured;
  setMessageSenderForTests(async (input) => {
    captured = input;
    return { success: true };
  });
  t.after(() => resetMessageSenderForTests());
  await sendTicketAlert({
    db,
    tenantId: 'tenant-a',
    kind: 'created',
    ticket: { id: 'WX-MENTION', cat: '测试', message: '艾特主管' },
    actor: { name: '系统测试' },
  });
  assert.deepEqual(captured.body.payload.mention, ['manager-contact-a']);
  assert.equal(Object.hasOwn(captured.body.payload, 'mentionContactIds'), false);
});

test('测试发送器异常与上游失败仅暴露安全错误元数据', async (t) => {
  const db = await fixture();
  const previousToken = config.JZMM_MSG_TOKEN;
  const token = 'real-test-msg-token-should-never-leak';
  config.JZMM_MSG_TOKEN = token;
  t.after(() => { config.JZMM_MSG_TOKEN = previousToken; });
  t.after(() => resetMessageSenderForTests());
  saveTenantAlertConfig(db, 'tenant-a', {
    roomId: 'secret-room-a',
    imBotId: 'secret-bot-a',
    managerContactId: 'secret-manager-contact-a',
    contactMap: {},
  });
  const warnings = captureWarnings(t);
  const sensitiveText = '敏感消息正文-不得记录';
  const sensitiveError = `request to https://example.test/send?token=${token} failed; room=secret-room-a; body=${sensitiveText}`;

  setMessageSenderForTests(async () => { throw new Error(sensitiveError); });
  const networkFailure = await sendTicketAlert({
    db, tenantId: 'tenant-a', kind: 'created',
    ticket: { id: 'SAFE-1', cat: '测试', message: sensitiveText },
  });
  assert.deepEqual(networkFailure, {
    success: false,
    error: { code: 'JZM_MESSAGE_NETWORK_ERROR' },
  });

  setMessageSenderForTests(async () => ({
    success: false,
    httpStatus: 502,
    error: { errcode: 40013, requestId: 'req-safe-1', message: sensitiveError },
  }));
  const upstreamFailure = await sendTicketAlert({
    db, tenantId: 'tenant-a', kind: 'created',
    ticket: { id: 'SAFE-2', cat: '测试', message: sensitiveText },
  });
  assert.deepEqual(upstreamFailure, {
    success: false,
    error: {
      code: 'JZM_MESSAGE_UPSTREAM_ERROR',
      httpStatus: 502,
      errcode: 40013,
      requestId: 'req-safe-1',
    },
  });

  const visibleFailureData = JSON.stringify({ warnings, networkFailure, upstreamFailure });
  for (const secret of [token, sensitiveError, sensitiveText, 'secret-room-a', 'secret-bot-a', 'secret-manager-contact-a']) {
    assert.equal(visibleFailureData.includes(secret), false, `失败日志或返回值不得包含：${secret}`);
  }
  assert.match(warnings.join('\n'), /JZM_MESSAGE_NETWORK_ERROR/);
  assert.match(warnings.join('\n'), /req-safe-1/);
});

test('通知 reject 或返回失败不回滚工单创建与状态更新且路由日志脱敏', async (t) => {
  const db = await fixture();
  const server = await tenantServer(db);
  t.after(() => server.close());
  await configure(server);
  const previousToken = config.JZMM_MSG_TOKEN;
  const token = 'route-test-msg-token-should-never-leak';
  config.JZMM_MSG_TOKEN = token;
  t.after(() => { config.JZMM_MSG_TOKEN = previousToken; });
  t.after(() => resetMessageSenderForTests());
  const warnings = captureWarnings(t);
  const sensitiveError = `https://example.test/send?token=${token} room-a bot-a manager-contact-a 路由敏感正文`;

  setMessageSenderForTests(async () => { throw new Error(sensitiveError); });
  const created = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'repair', cat: '安防', desc: '门禁异常', loc: '东门', message: '路由敏感正文', community_id: 'c1' }),
  });
  assert.equal(created.response.status, 200);
  const id = created.body.record.id;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(one(db, 'SELECT id FROM tickets WHERE id = ? AND tenant_id = ?', [id, 'tenant-a']).id, id);

  setMessageSenderForTests(async () => ({
    success: false,
    httpStatus: 503,
    error: { errcode: 50001, requestId: 'req-route-safe', message: sensitiveError },
  }));
  const updated = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worker: '张师傅', status: 'doing' }),
  });
  assert.equal(updated.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    one(db, 'SELECT status, worker FROM tickets WHERE id = ? AND tenant_id = ?', [id, 'tenant-a']),
    { status: 'doing', worker: '张师傅' }
  );

  const warningText = warnings.join('\n');
  for (const secret of [token, sensitiveError, '路由敏感正文', 'room-a', 'bot-a', 'manager-contact-a']) {
    assert.equal(warningText.includes(secret), false, `路由日志不得包含：${secret}`);
  }
  assert.match(warningText, /JZM_MESSAGE_NETWORK_ERROR/);
  assert.match(warningText, /req-route-safe/);
});

test('不同租户提醒只使用各自群机器人与联系人映射', async (t) => {
  const db = await fixture();
  seedTenant(db, { id: 'tenant-b', name: '测试企业B' });
  saveTenantAlertConfig(db, 'tenant-a', {
    roomId: 'room-a', imBotId: 'bot-a', managerContactId: 'manager-a',
    contactMap: { '张师傅': 'worker-a' },
  });
  saveTenantAlertConfig(db, 'tenant-b', {
    roomId: 'room-b', imBotId: 'bot-b', managerContactId: 'manager-b',
    contactMap: { '王师傅': 'worker-b' },
  });
  const calls = [];
  setMessageSenderForTests(async (input) => { calls.push(input); return { success: true }; });
  t.after(() => resetMessageSenderForTests());

  await sendTicketAlert({
    db, tenantId: 'tenant-a', kind: 'created',
    ticket: { id: 'TA-1', cat: '水暖', message: 'A 企业工单' },
  });
  await sendTicketAlert({
    db, tenantId: 'tenant-b', kind: 'assigned',
    ticket: { id: 'TB-1', cat: '电路', worker: '王师傅', message: 'B 企业工单' },
    assignee: { displayName: '王师傅' },
  });

  assert.deepEqual(calls.map(({ body }) => ({
    roomId: body.imRoomId,
    botId: body.imBotId,
    mention: body.payload.mention,
  })), [
    { roomId: 'room-a', botId: 'bot-a', mention: ['manager-a'] },
    { roomId: 'room-b', botId: 'bot-b', mention: ['worker-b'] },
  ]);
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
  assert.deepEqual(calls.at(-1).body.payload.mention, ['manager-contact-a']);
  assert.match(calls.at(-1).body.payload.text, /紧急消息提醒/);

  const assigned = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'repair', cat: '电路', desc: '跳闸', loc: '2号楼', message: '配电箱跳闸', worker: '张师傅', status: 'doing', community_id: 'c1' }),
  });
  assert.equal(assigned.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).body.payload.mention, ['worker-contact-a']);
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
  assert.deepEqual(calls.at(-1).body.payload.mention, ['manager-contact-a']);
  const assigned = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worker: '张师傅', status: 'doing' }),
  });
  assert.equal(assigned.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).body.payload.mention, ['worker-contact-a']);
  assert.match(calls.at(-1).body.payload.text, /新的派单提醒/);
  assert.match(calls.at(-1).body.payload.text, /您有新的派单，请及时处理/);
  assert.match(calls.at(-1).body.payload.text, new RegExp(id));
  assert.match(calls.at(-1).body.payload.text, /门窗/);
  assert.match(calls.at(-1).body.payload.text, /1号楼/);

  const callsAfterAssignment = calls.length;
  const unchangedAssignee = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worker: ' 张师傅 ', priority: '紧急' }),
  });
  assert.equal(unchangedAssignee.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterAssignment, '处理人未变时不应重复发送派单提醒');

  const reassigned = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worker: '李师傅' }),
  });
  assert.equal(reassigned.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterAssignment + 1, '改派应只新增一条提醒');
  assert.deepEqual(calls.at(-1).body.payload.mention, ['worker-contact-b']);
  assert.match(calls.at(-1).body.payload.text, /您有新的派单，请及时处理/);

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
  assert.match(calls.at(-1).body.payload.text, new RegExp(id));
  assert.match(calls.at(-1).body.payload.text, /门窗/);
  assert.match(calls.at(-1).body.payload.text, /1号楼/);
  assert.match(calls.at(-1).body.payload.text, /处理人：李师傅/);
  assert.match(calls.at(-1).body.payload.text, /该工单已处理完成/);
  assert.match(calls.at(-1).body.payload.text, /完成时间：/);
  assert.deepEqual(calls.at(-1).body.payload.mention, []);

  const callsAfterCompletion = calls.length;
  const completedAgain = await request(server, `/api/tickets/${id}`, SUPERVISOR, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', priority: '普通' }),
  });
  assert.equal(completedAgain.response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterCompletion, '重复保存已完成工单不应重复提醒');
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
  assert.deepEqual(calls.at(-1).body.payload.mention, ['manager-contact-a']);
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
  assert.deepEqual(calls.at(-1).body.payload.mention, []);

  await sendTicketAlert({
    db, tenantId: 'tenant-a', kind: 'assigned',
    ticket: { id: 'WA-1', cat: '电路', worker: '未配置师傅', message: '不应@主管' },
    assignee: { displayName: '未配置师傅' },
  });
  assert.deepEqual(calls.at(-1).body.payload.mention, []);
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
      // 上游秒回模型可能返回 complain；服务端应归一化为 complaint。
      type: 'complain', cat: '水暖', desc: '3号楼漏水', loc: '3号楼',
      message: '请尽快处理', community_name: '测试小区',
      status: 'done', worker: '不应由外部接口指定',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { success: true });
  const stored = one(db, 'SELECT tenant_id,type,status,worker FROM tickets ORDER BY created DESC LIMIT 1');
  assert.deepEqual(stored, { tenant_id: 'tenant-a', type: 'complaint', status: 'wait', worker: '' });
  assert.equal(getTenantAlertConfig(db, 'tenant-a').roomId, 'room-a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1).body.imRoomId, 'room-a');
  assert.deepEqual(calls.at(-1).body.payload.mention, ['manager-contact-a']);
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
