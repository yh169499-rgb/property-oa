const test = require('node:test');
const assert = require('node:assert/strict');

const { createFullTestDB, rows } = require('./helpers/tenant-fixture');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');
const { analyzeReport } = require('../services/ai-report');

const TENANT_A = 'tenant-workforce-a';
const TENANT_B = 'tenant-workforce-b';
const DATE = '2026-08-19';

function ruleValues(tenantId, version, name, active = 1) {
  return [
    tenantId, version, name, 30, 50, 20, 90, 80, 60, 1,
    '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', active,
  ];
}

async function fixture() {
  const db = await createFullTestDB();
  db.run(`INSERT INTO tenants
    (id,name,status,owner_user_id,staff_limit,created_at,updated_at) VALUES
    (?,?, 'active',NULL,4,'test','test'),
    (?,?, 'active',NULL,4,'test','test')`, [TENANT_A, '甲企业', TENANT_B, '乙企业']);
  db.run(`INSERT INTO users
    (id,phone,password,name,role,status,tenant_id,session_version) VALUES
    (101,'13810000101','fixture','甲主管','主管','active',?,0),
    (102,'13810000102','fixture','甲师傅','worker','active',?,0),
    (201,'13810000201','fixture','乙主管','主管','active',?,0),
    (202,'13810000202','fixture','tenant-b-secret-worker','worker','active',?,0)`,
  [TENANT_A, TENANT_A, TENANT_B, TENANT_B]);
  db.run('UPDATE tenants SET owner_user_id=101 WHERE id=?', [TENANT_A]);
  db.run('UPDATE tenants SET owner_user_id=201 WHERE id=?', [TENANT_B]);
  db.run(`INSERT INTO staff_profiles
    (id,tenant_id,user_id,name,position,manager_id,employment_status,created_at,updated_at) VALUES
    (11,?,101,'甲主管','主管',NULL,'active','test','test'),
    (12,?,102,'甲师傅','维修师傅',11,'active','test','test'),
    (21,?,201,'乙主管','主管',NULL,'active','test','test'),
    (22,?,202,'tenant-b-secret-worker','维修师傅',21,'active','test','test')`,
  [TENANT_A, TENANT_A, TENANT_B, TENANT_B]);
  db.run(`INSERT INTO communities(id,tenant_id,name,created) VALUES
    ('community-a',?,'甲小区','test'),
    ('community-b',?,'tenant-b-secret-community','test')`, [TENANT_A, TENANT_B]);
  db.run(`INSERT INTO shift_templates
    (id,tenant_id,name,start_time,end_time,color,created_by) VALUES
    (31,?,'甲白班','08:00','18:00','#111',101),
    (32,?,'tenant-b-secret-shift','09:00','19:00','#222',201)`, [TENANT_A, TENANT_B]);
  db.run(`INSERT INTO shift_assignments
    (id,tenant_id,staff_id,work_date,assignment_type,template_id,start_at,end_at,created_by) VALUES
    (41,?,12,?,'work',31,'2026-08-19T08:00:00+08:00','2026-08-19T18:00:00+08:00',101),
    (42,?,22,?,'work',32,'2026-08-19T09:00:00+08:00','2026-08-19T19:00:00+08:00',201)`,
  [TENANT_A, DATE, TENANT_B, DATE]);
  db.run(`INSERT INTO performance_rule_versions
    (tenant_id,version_no,name,completion_weight,on_time_weight,quality_weight,
     excellent_threshold,good_threshold,qualified_threshold,minimum_sample_size,
     effective_at,created_at,is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ruleValues(TENANT_A, 1, '甲规则'));
  db.run(`INSERT INTO performance_rule_versions
    (tenant_id,version_no,name,completion_weight,on_time_weight,quality_weight,
     excellent_threshold,good_threshold,qualified_threshold,minimum_sample_size,
     effective_at,created_at,is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ruleValues(TENANT_B, 1, 'tenant-b-secret-rule'));
  const ruleA = rows(db, 'SELECT id FROM performance_rule_versions WHERE tenant_id=?', [TENANT_A])[0].id;
  const ruleB = rows(db, 'SELECT id FROM performance_rule_versions WHERE tenant_id=?', [TENANT_B])[0].id;
  db.run(`INSERT INTO tickets
    (id,tenant_id,type,cat,desc,loc,status,worker,created,assigned_at,finished,
     estimated_hours,community_id,assignee_user_id,assignee_staff_profile_id,
     performance_rule_version_id) VALUES
    ('A-TICKET',?,'repair','甲分类','甲工单','甲1栋','done','甲师傅',
     '2026-08-19T01:00:00.000Z','2026-08-19T01:00:00.000Z','2026-08-19T02:00:00.000Z',2,
     'community-a',102,12,?),
    ('B-SECRET-TICKET',?,'help','tenant-b-secret-category','tenant-b-secret-description',
     'tenant-b-secret-location','doing','tenant-b-secret-worker','2026-08-19T01:00:00.000Z',
     '2026-08-19T01:00:00.000Z','',2,'community-b',202,22,?)`,
  [TENANT_A, ruleA, TENANT_B, ruleB]);
  const server = await startHttpServer(db);
  return { db, server };
}

function managerHeaders(id) {
  return { 'Content-Type': 'application/json', ...authHeader({ id }) };
}

async function json(server, path, id, options = {}) {
  const response = await fetch(server.url + path, {
    ...options,
    headers: { ...managerHeaders(id), ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = text; }
  }
  return { status: response.status, body };
}

test('derived workforce endpoints only expose the authenticated tenant', async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const paths = [
    '/api/shift-templates',
    `/api/shifts?date_from=${DATE}&date_to=${DATE}`,
    `/api/calendar/day?date=${DATE}`,
    '/api/dashboard/stats?range=all',
    '/api/reports/staff/all?from=2026-08-01&to=2026-08-31',
    '/api/settings/performance',
  ];
  for (const path of paths) {
    const result = await json(server, path, 101);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    assert.equal(JSON.stringify(result.body).includes('tenant-b-secret'), false, path);
  }
});

test('shift mutations cannot reference or mutate another tenant records', async (t) => {
  const { db, server } = await fixture();
  t.after(() => server.close());
  const create = await json(server, '/api/shifts', 101, {
    method: 'POST',
    body: JSON.stringify({ staffId: 12, workDate: '2026-08-20', assignmentType: 'work', templateId: 32 }),
  });
  assert.equal(create.status, 404);
  assert.equal(create.body.code, 'SHIFT_TEMPLATE_NOT_FOUND');

  const patch = await json(server, '/api/shifts/42', 101, {
    method: 'PATCH', body: JSON.stringify({ note: '越权修改' }),
  });
  assert.equal(patch.status, 404);
  const remove = await json(server, '/api/shifts/42', 101, { method: 'DELETE' });
  assert.equal(remove.status, 404);
  assert.equal(rows(db, 'SELECT note FROM shift_assignments WHERE id=42')[0].note, '');
});

test('client supplied tenant fields are rejected instead of trusted', async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  for (const [path, method, body] of [
    ['/api/shift-templates', 'POST', { tenant_id: TENANT_B, name: '越权', startTime: '08:00', endTime: '18:00' }],
    ['/api/shifts', 'POST', { tenantId: TENANT_B, staffId: 12, workDate: '2026-08-20', assignmentType: 'rest' }],
    ['/api/settings/performance/versions', 'POST', {
      tenant_id: TENANT_B, name: '越权', completionWeight: 30, onTimeWeight: 50,
      qualityWeight: 20, excellentThreshold: 90, goodThreshold: 80,
      qualifiedThreshold: 60, minimumSampleSize: 1,
    }],
    ['/api/reports/staff/12/ai-analysis', 'POST', {
      tenantId: TENANT_B, from: '2026-08-01', to: '2026-08-31',
    }],
  ]) {
    const result = await json(server, path, 101, { method, body: JSON.stringify(body) });
    assert.equal(result.status, 400, path);
    assert.equal(result.body.code, 'CLIENT_TENANT_FORBIDDEN', path);
  }
  for (const path of [
    `/api/calendar/day?date=${DATE}&tenant_id=${TENANT_B}`,
    `/api/reports/ai/status?tenantId=${TENANT_B}`,
  ]) {
    const result = await json(server, path, 101);
    assert.equal(result.status, 400, path);
    assert.equal(result.body.code, 'CLIENT_TENANT_FORBIDDEN', path);
  }
});

test('reminder and SLA settings are stored independently per tenant', async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const setA = await json(server, '/api/settings/reminder', 101, {
    method: 'POST', body: JSON.stringify({ intervalMinutes: 7 }),
  });
  assert.equal(setA.status, 200);
  const tenantB = await json(server, '/api/settings/reminder', 201);
  await json(server, '/api/settings/reminder', 101, {
    method: 'POST', body: JSON.stringify({ intervalMinutes: 0 }),
  });
  assert.equal(tenantB.status, 200);
  assert.equal(tenantB.body.intervalMinutes, 0);

  await json(server, '/api/settings/sla', 101, {
    method: 'POST', body: JSON.stringify({ intervalMinutes: 9 }),
  });
  const tenantBSla = await json(server, '/api/settings/sla', 201);
  await json(server, '/api/settings/sla', 101, {
    method: 'POST', body: JSON.stringify({ intervalMinutes: 0 }),
  });
  assert.equal(tenantBSla.status, 200);
  assert.equal(tenantBSla.body.intervalMinutes, 0);
});

test('AI cache hashes and rows are isolated by tenant', async (t) => {
  const { db, server } = await fixture();
  t.after(() => server.close());
  const config = {
    AI_REPORT_ENABLED: true,
    AI_API_KEY: 'fixture-key',
    AI_BASE_URL: 'https://fixture.invalid/v1',
    AI_MODEL: 'fixture-model',
    AI_REPORT_PROMPT_VERSION: 'v1',
    AI_TIMEOUT_MS: 1000,
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        summary: `analysis-${calls}`, highlights: [], issues: [], trends: [], risks: [], recommendations: [],
      }) } }] }),
    };
  };
  const report = { staff: { position: '维修师傅' }, received: { total: 1 }, completed: { total: 1 } };
  const common = { db, report, filters: { from: '2026-08-01', to: '2026-08-31' }, config, fetchImpl };
  const a = await analyzeReport({ ...common, tenantId: TENANT_A, staffProfileId: 12, actorUserId: 101 });
  const b = await analyzeReport({ ...common, tenantId: TENANT_B, staffProfileId: 22, actorUserId: 201 });
  assert.equal(a.cached, false);
  assert.equal(b.cached, false);
  assert.equal(calls, 2);
  const cache = rows(db, 'SELECT tenant_id,report_hash,analysis_json FROM ai_report_analyses ORDER BY tenant_id');
  assert.deepEqual(cache.map((row) => row.tenant_id), [TENANT_A, TENANT_B]);
  assert.notEqual(cache[0].report_hash, cache[1].report_hash);
});

test('attendance HTTP APIs are not part of the product surface', async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  for (const path of ['/api/attendance/summary', '/api/me/attendance']) {
    const result = await json(server, path, 101);
    assert.equal(result.status, 404, path);
  }
});
