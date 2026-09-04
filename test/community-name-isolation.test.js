const test = require('node:test');
const assert = require('node:assert/strict');

const { authHeader } = require('./helpers/auth');
const { createFullTestDB } = require('./helpers/tenant-fixture');
const { startHttpServer } = require('./helpers/http-server');
const { ensureTenantSchema } = require('../services/tenant-schema');

async function fixture(t) {
  const db = await createFullTestDB();
  db.run(`
    INSERT INTO tenants
      (id, name, status, owner_user_id, staff_limit, created_at, updated_at) VALUES
      ('tenant-a', '企业 A', 'active', NULL, 4, '2026-09-04', '2026-09-04'),
      ('tenant-b', '企业 B', 'active', NULL, 4, '2026-09-04', '2026-09-04');
    INSERT INTO users
      (id, phone, password, name, role, status, tenant_id, session_version) VALUES
      (1, '13800000001', 'x', 'A 主管', '主管', 'active', 'tenant-a', 0),
      (2, '13900000001', 'x', 'B 主管', '主管', 'active', 'tenant-b', 0);
    UPDATE tenants SET owner_user_id = 1 WHERE id = 'tenant-a';
    UPDATE tenants SET owner_user_id = 2 WHERE id = 'tenant-b';
  `);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  return { db, server };
}

async function createCommunity(server, userId, name) {
  const response = await fetch(`${server.url}/api/communities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader({ id: userId }) },
    body: JSON.stringify({ name }),
  });
  return { response, body: await response.json() };
}

test('不同企业允许建立同名小区且查询互相隔离', async (t) => {
  const { server } = await fixture(t);
  assert.equal((await createCommunity(server, 1, '阳光花园')).response.status, 200);
  assert.equal((await createCommunity(server, 2, '阳光花园')).response.status, 200);

  const a = await fetch(`${server.url}/api/communities`, { headers: authHeader({ id: 1 }) });
  const b = await fetch(`${server.url}/api/communities`, { headers: authHeader({ id: 2 }) });
  const aBody = await a.json();
  const bBody = await b.json();
  assert.equal(aBody.data.length, 1);
  assert.equal(bBody.data.length, 1);
  assert.notEqual(aBody.data[0].id, bBody.data[0].id);
});

test('同一企业内规范化后的同名小区返回明确冲突', async (t) => {
  const { server } = await fixture(t);
  assert.equal((await createCommunity(server, 1, ' 阳光花园 ')).response.status, 200);
  const duplicate = await createCommunity(server, 1, '阳光花园');
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.code, 'COMMUNITY_NAME_EXISTS');
});

test('启动迁移归并同企业历史重名小区并保留业务引用', async () => {
  const db = await createFullTestDB();
  db.run('DROP INDEX uq_communities_tenant_normalized_name');
  db.run(`
    INSERT INTO tenants
      (id, name, status, staff_limit, created_at, updated_at)
      VALUES ('tenant-a', '企业 A', 'active', 4, '2026-09-04', '2026-09-04');
    INSERT INTO communities (id, tenant_id, name, address, created) VALUES
      ('c-old', 'tenant-a', '阳光花园', '旧址', '2026-01-01'),
      ('c-new', 'tenant-a', ' 阳光花园 ', '新址', '2026-02-01');
    INSERT INTO tickets (id, tenant_id, type, cat, created, community_id)
      VALUES ('WX-DUP', 'tenant-a', 'repair', '水暖', '2026-09-04', 'c-new');
  `);

  ensureTenantSchema(db);

  assert.equal(db.exec("SELECT COUNT(*) FROM communities WHERE tenant_id='tenant-a'")[0].values[0][0], 1);
  assert.equal(db.exec("SELECT community_id FROM tickets WHERE id='WX-DUP'")[0].values[0][0], 'c-old');
});
