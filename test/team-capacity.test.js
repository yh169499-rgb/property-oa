const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const {
  TEAM_LIMITS,
  normalizedStaffRole,
  teamUsage,
  assertTeamCapacity,
  findSoleSupervisorProfile,
} = require('../services/team-capacity');

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE staff_profiles (
      id INTEGER PRIMARY KEY,
      name TEXT DEFAULT '',
      position TEXT DEFAULT '',
      manager_id INTEGER,
      employment_status TEXT DEFAULT 'active'
    );
    INSERT INTO staff_profiles
      (id, name, position, manager_id, employment_status)
    VALUES
      (10, '唯一主管', '主管', NULL, 'active'),
      (11, '维修甲', 'worker', 10, 'active'),
      (12, '维修乙', '维修工', 10, 'active'),
      (13, '维修丙', '维修师傅', 10, 'active'),
      (14, '管家甲', '物业管家', 10, 'active'),
      (15, '离职管家', '管家', 10, 'inactive'),
      (16, '其他团队维修', '维修师傅', 99, 'active');
  `);
  return db;
}

test('岗位规范化只识别维修师傅和管家岗位', () => {
  assert.deepEqual(TEAM_LIMITS, { total: 4, worker: 3, keeper: 1 });
  assert.equal(Object.isFrozen(TEAM_LIMITS), true);
  for (const value of ['worker', '维修工', '维修师傅']) {
    assert.equal(normalizedStaffRole(value), 'worker');
  }
  for (const value of ['keeper', '物业管家', '管家']) {
    assert.equal(normalizedStaffRole(value), 'keeper');
  }
  assert.equal(normalizedStaffRole('主管'), null);
  assert.equal(normalizedStaffRole(''), null);
});

test('团队用量只统计主管直属 active 人员并支持排除本人', async () => {
  const db = await fixture();
  assert.deepEqual(teamUsage(db, 10), {
    total: 4,
    totalLimit: 4,
    worker: 3,
    workerLimit: 3,
    keeper: 1,
    keeperLimit: 1,
  });
  assert.deepEqual(teamUsage(db, 10, { excludeProfileId: 13 }), {
    total: 3,
    totalLimit: 4,
    worker: 2,
    workerLimit: 3,
    keeper: 1,
    keeperLimit: 1,
  });
});

test('岗位已满时容量校验返回 409 和当前用量详情', async () => {
  const db = await fixture();
  assert.throws(
    () => assertTeamCapacity(db, 10, '维修师傅'),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'ROLE_CAPACITY_FULL');
      assert.deepEqual(error.details, {
        usage: teamUsage(db, 10),
        role: 'worker',
      });
      return true;
    }
  );
  assert.throws(
    () => assertTeamCapacity(db, 10, '物业管家'),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'ROLE_CAPACITY_FULL');
      assert.deepEqual(error.details, {
        usage: teamUsage(db, 10),
        role: 'keeper',
      });
      return true;
    }
  );
});

test('总人数已满优先返回 TEAM_CAPACITY_FULL', async () => {
  const db = await fixture();
  db.run("UPDATE staff_profiles SET position = '未知岗位' WHERE id = 14");
  assert.throws(
    () => assertTeamCapacity(db, 10, '管家'),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'TEAM_CAPACITY_FULL');
      assert.deepEqual(error.details.usage, teamUsage(db, 10));
      assert.equal(error.details.role, 'keeper');
      return true;
    }
  );
});

test('排除本人后有容量时返回排除后的团队用量', async () => {
  const db = await fixture();
  const usage = assertTeamCapacity(db, 10, 'worker', { excludeProfileId: 13 });
  assert.deepEqual(usage, {
    total: 3,
    totalLimit: 4,
    worker: 2,
    workerLimit: 3,
    keeper: 1,
    keeperLimit: 1,
  });
});

test('只能定位唯一 active 主管档案', async () => {
  const db = await fixture();
  assert.deepEqual(findSoleSupervisorProfile(db), {
    id: 10,
    name: '唯一主管',
    position: '主管',
    manager_id: null,
    employment_status: 'active',
  });

  db.run("UPDATE staff_profiles SET employment_status = 'inactive' WHERE id = 10");
  assert.throws(
    () => findSoleSupervisorProfile(db),
    (error) => error.code === 'SUPERVISOR_PROFILE_NOT_FOUND'
  );

  db.run(`
    UPDATE staff_profiles SET employment_status = 'active' WHERE id = 10;
    INSERT INTO staff_profiles
      (id, name, position, manager_id, employment_status)
    VALUES (20, '第二主管', '主管', NULL, 'active');
  `);
  assert.throws(
    () => findSoleSupervisorProfile(db),
    (error) => error.code === 'MULTIPLE_SUPERVISOR_PROFILES'
  );
});

test('主管档案定位兼容项目已有的全部主管岗位别名', async () => {
  const db = await fixture();
  for (const alias of ['admin', 'lead', 'manager', 'supervisor', '主管', '经理']) {
    db.run('UPDATE staff_profiles SET position = ? WHERE id = 10', [alias]);
    const profile = findSoleSupervisorProfile(db);
    assert.equal(profile.id, 10);
    assert.equal(profile.position, alias);
  }
});

test('不同主管岗位别名同时存在时仍明确报告多名主管', async () => {
  const db = await fixture();
  db.run(`
    UPDATE staff_profiles SET position = 'lead' WHERE id = 10;
    INSERT INTO staff_profiles
      (id, name, position, manager_id, employment_status)
    VALUES (20, '第二主管', 'manager', NULL, 'active');
  `);
  assert.throws(
    () => findSoleSupervisorProfile(db),
    (error) => error.code === 'MULTIPLE_SUPERVISOR_PROFILES'
      && error.details.count === 2
  );
});
