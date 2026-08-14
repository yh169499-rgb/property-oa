const test = require('node:test');
const assert = require('node:assert/strict');
const {
  descendantIds,
  wouldCreateCycle,
  buildOrganizationTree,
  updateManager,
} = require('../services/organization');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');

const profiles = [
  { id: 1, name: '主管', manager_id: null },
  { id: 2, name: '组长', manager_id: 1 },
  { id: 3, name: '师傅', manager_id: 2 },
  { id: 4, name: '未分配人员', manager_id: null },
];

test('组织纯函数支持任意深度下级、循环检测和未分配人员', () => {
  assert.deepEqual(descendantIds(profiles, 1), [2, 3]);
  assert.equal(wouldCreateCycle(profiles, 1, 3), true);
  assert.equal(wouldCreateCycle(profiles, 3, 1), false);
  const organization = buildOrganizationTree(profiles);
  assert.equal(organization.tree[0].children[0].children[0].id, 3);
  assert.equal(organization.unassigned[0].id, 4);
});

test('updateManager 拒绝本人或下级作为上级并提供循环路径', async () => {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO staff_profiles (id, name, manager_id) VALUES
      (1, '主管', NULL), (2, '组长', 1), (3, '师傅', 2)
  `);

  assert.throws(
    () => updateManager(db, 1, 3),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'ORGANIZATION_CYCLE');
      assert.deepEqual(error.details, {
        staffId: 1,
        managerId: 3,
        path: [1, 2, 3, 1],
      });
      return true;
    }
  );
});

test('updateManager 拒绝不存在的人员和直属上级', async () => {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  db.run("INSERT INTO staff_profiles (id, name) VALUES (1, '主管')");

  assert.throws(
    () => updateManager(db, 99, null),
    (error) => error.status === 404 && error.code === 'PROFILE_NOT_FOUND'
  );
  assert.throws(
    () => updateManager(db, 1, 99),
    (error) => error.status === 404 && error.code === 'MANAGER_NOT_FOUND'
  );
  assert.equal(
    db.exec('SELECT manager_id FROM staff_profiles WHERE id = 1')[0].values[0][0],
    null
  );
});

test('updateManager 对直属在职团队实施 4/3/1 容量限制并排除本人', async () => {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO staff_profiles
      (id, name, position, manager_id, employment_status) VALUES
      (1, '主管', '主管', NULL, 'active'),
      (2, '师傅一', '维修师傅', 1, 'active'),
      (3, '师傅二', '维修师傅', 1, 'active'),
      (4, '师傅三', '维修师傅', 1, 'active'),
      (5, '管家', '物业管家', 1, 'active'),
      (6, '候选师傅', '维修师傅', NULL, 'inactive')
  `);

  assert.equal(updateManager(db, 2, 1).manager_id, 1);
  assert.throws(
    () => updateManager(db, 6, 1, {
      profile: { position: '维修师傅', employment_status: 'active' },
    }),
    (error) => error.status === 409 && error.code === 'ROLE_CAPACITY_FULL'
  );
  assert.equal(
    db.exec('SELECT manager_id FROM staff_profiles WHERE id = 6')[0].values[0][0],
    null
  );
});

test('updateManager 拒绝在职普通员工无主管或绑定非主管', async () => {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO staff_profiles
      (id, name, position, manager_id, employment_status) VALUES
      (1, '主管', '主管', NULL, 'active'),
      (2, '普通师傅', '维修师傅', 1, 'active'),
      (3, '另一师傅', '维修师傅', 1, 'active')
  `);

  assert.throws(
    () => updateManager(db, 2, null),
    (error) => error.status === 409 && error.code === 'ACTIVE_STAFF_MANAGER_REQUIRED'
  );
  assert.throws(
    () => updateManager(db, 2, 3),
    (error) => error.status === 409 && error.code === 'INVALID_ACTIVE_MANAGER'
  );
  assert.equal(
    db.exec('SELECT manager_id FROM staff_profiles WHERE id = 2')[0].values[0][0],
    1
  );
});
