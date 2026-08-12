const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('./helpers/test-db');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { migrateUsersToProfiles } = require('../services/workforce-migration');

async function fixture(t) {
  const db = await createTestDB();
  db.run(`
    INSERT INTO users (id, phone, password, name, role) VALUES
      (1, '13800000001', 'x', '主管', 'lead'),
      (2, '13800112201', 'x', '张师傅', 'worker'),
      (3, '13800112203', 'x', '同名', 'worker'),
      (4, '13800112204', 'x', '同名', 'worker')
  `);
  ensureWorkforceSchema(db);
  migrateUsersToProfiles(db, '2026-07-30T00:00:00.000Z');
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

async function post(server, path, body, role = 'lead') {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader({ id: 1, role }),
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('旧资料预览按手机号优先、唯一姓名匹配并报告同名冲突，且不写数据库', async (t) => {
  const { db, server } = await fixture(t);
  const profiles = [
    { name: '错误姓名', phone: '13800112201', skill: '水暖', joinDate: '2024-01-02' },
    { name: '张师傅', skill: '电工' },
    { name: '同名', skill: '弱电' },
  ];
  const before = db.export();
  const result = await post(server, '/api/staff/profiles/import-preview', { profiles });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.matches[0].matched_by, 'phone');
  assert.equal(result.body.data.matches[1].matched_by, 'name');
  assert.equal(result.body.data.conflicts.length, 1);
  assert.deepEqual(db.export(), before);
});

test('确认只写勾选字段，相同规范化内容幂等且普通用户无权导入', async (t) => {
  const { db, server } = await fixture(t);
  const profiles = [{ phone: '13800112201', name: '张师傅', skill: '水暖', joinDate: '2024-01-02' }];
  const first = await post(server, '/api/staff/profiles/import-confirm', {
    profiles,
    selections: [{ index: 0, fields: ['skill'] }],
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.already_imported, false);
  assert.deepEqual(
    db.exec("SELECT skill, join_date FROM staff_profiles WHERE phone = '13800112201'")[0].values[0],
    ['水暖', '']
  );

  const second = await post(server, '/api/staff/profiles/import-confirm', {
    selections: [{ fields: ['skill'], index: 0 }],
    profiles: [{ skill: '水暖', name: '张师傅', joinDate: '2024-01-02', phone: '13800112201' }],
  });
  assert.equal(second.body.data.already_imported, true);
  assert.equal(db.exec('SELECT COUNT(*) FROM workforce_import_batches')[0].values[0][0], 1);

  const deniedResponse = await fetch(`${server.url}/api/staff/profiles/import-preview`, {
    headers: { 'Content-Type': 'application/json', ...authHeader({ id: 2, role: 'worker' }) },
  });
  const denied = { response: deniedResponse };
  assert.equal(denied.response.status, 403);
});
