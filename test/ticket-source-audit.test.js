const test = require('node:test');
const assert = require('node:assert/strict');
const { createFullTestDB, seedTenant, tenantServer, one, rows } = require('./helpers/tenant-fixture');
const { authHeader } = require('./helpers/auth');
const config = require('../config');

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

test('外部建单保存企业、小区、反馈人、原文和脱敏请求摘要', async (t) => {
  const db = await fixture();
  const server = await tenantServer(db, undefined, { id: 'tenant-a', name: '测试企业' });
  t.after(() => server.close());
  const previousToken = config.JZMM_INGEST_TOKEN;
  config.JZMM_INGEST_TOKEN = 'integration-test-token';
  t.after(() => { config.JZMM_INGEST_TOKEN = previousToken; });
  const result = await request(server, '/api/tickets/external', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-JZM-Ingest-Token': 'integration-test-token' },
    body: JSON.stringify({
      enterprise_name: '测试企业', community_name: '测试小区',
      sender_name: 'Kitty', feedback_group: '居民群', original_message: '居民原始文本',
      type: 'repair', cat: '水暖', desc: '漏水', loc: '3号楼', message: '{"整理消息":"整理后的文本"}',
    }),
  });
  assert.equal(result.response.status, 200);
  const audit = one(db, 'SELECT * FROM ticket_source_audits ORDER BY id DESC LIMIT 1');
  assert.equal(audit.feedback_person, 'Kitty');
  assert.equal(audit.original_message, '居民原始文本');
  assert.equal(audit.community_name, '测试小区');
  assert.match(audit.request_json, /测试企业/);
  assert.doesNotMatch(audit.request_json, /integration-test-token/);
});

test('来源查询只返回当前租户且按工单号可定位预警来源', async (t) => {
  const db = await fixture();
  const server = await tenantServer(db, undefined, { id: 'tenant-a', name: '测试企业' });
  t.after(() => server.close());
  db.run(`INSERT INTO ticket_source_audits
    (tenant_id, ticket_id, enterprise_name, community_id, community_name, feedback_person,
     feedback_group, original_message, source, request_json, created_at)
    VALUES ('tenant-a','WX8030','测试企业','c1','测试小区','Kitty','居民群','原文','external','{}','2026-09-07T03:40:00Z')`);
  db.run(`INSERT INTO ticket_source_audits
    (tenant_id, ticket_id, enterprise_name, community_id, community_name, feedback_person,
     feedback_group, original_message, source, request_json, created_at)
    VALUES ('tenant-b','WB-1','其他企业','c2','其他小区','Other','群','其他','external','{}','2026-09-07T03:40:00Z')`);
  const result = await request(server, '/api/ticket-source-audits?ticket_id=WX8030', SUPERVISOR);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].ticket_id, 'WX8030');
  assert.equal(result.body.data[0].tenant_id, undefined);
  const all = rows(db, 'SELECT tenant_id FROM ticket_source_audits');
  assert.equal(all.length, 2);
});
