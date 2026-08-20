const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');
const {
  approvePendingRegistration,
  createStaffAccount,
  departStaff,
} = require('../services/staff-lifecycle');

function one(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const value = statement.step() ? statement.getAsObject() : null;
  statement.free();
  return value;
}

async function fixture() {
  const db = await createTestDB();
  db.run('ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT \'active\'');
  db.run(`
    CREATE TABLE communities (id TEXT PRIMARY KEY, name TEXT, created TEXT);
    CREATE TABLE community_memberships (
      community_id TEXT NOT NULL,
      staff_profile_id INTEGER NOT NULL,
      created_at TEXT,
      UNIQUE (community_id, staff_profile_id)
    );
    CREATE TABLE pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      skill TEXT DEFAULT '',
      community_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created TEXT NOT NULL
    );
    CREATE TABLE staff_status (name TEXT PRIMARY KEY, status TEXT, updated TEXT);
    INSERT INTO communities VALUES ('default', '默认小区', '2026-01-01T00:00:00.000Z');
    INSERT INTO users (id, phone, password, name, role, status)
    VALUES (1, '13800000001', 'hash', '主管', '主管', 'active');
  `);
  ensureWorkforceSchema(db);
  db.run(`INSERT INTO staff_profiles
    (id, user_id, name, phone, position, employment_status, created_at, updated_at)
    VALUES (10, 1, '主管', '13800000001', '主管', 'active', '2026-01-01', '2026-01-01')`);
  return db;
}

function createInput(index, role = 'worker') {
  return {
    phone: `1380000010${index}`,
    passwordHash: `hash-${index}`,
    name: `${role === 'keeper' ? '管家' : '师傅'}${index}`,
    role,
    skill: role === 'keeper' ? '' : '综合维修',
    communityId: 'default',
    nowIso: `2026-08-0${index}T00:00:00.000Z`,
  };
}

test('创建人员在同一事务中建立账号、直属档案和小区成员关系', async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  const result = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });

  assert.equal(result.role, 'worker');
  assert.deepEqual(
    db.exec(`SELECT u.phone, sp.position, sp.manager_id, sp.employment_status
      FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
      WHERE u.id = ${Number(result.userId)}`)[0].values[0],
    ['13800000101', '维修师傅', 10, 'active']
  );
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM community_memberships WHERE staff_profile_id = ?', [result.profileId]).total, 1);
});

test('多名主管分别管理自己的四人名额', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  db.run(`INSERT INTO users (id, phone, password, name, role, status)
    VALUES (2, '13222514178', 'hash-2', '发财', '主管', 'active')`);
  db.run(`INSERT INTO staff_profiles
    (id, user_id, name, phone, position, employment_status, created_at, updated_at)
    VALUES (20, 2, '发财', '13222514178', '主管', 'active', '2026-01-01', '2026-01-01')`);

  const first = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  const second = createStaffAccount(db, createInput(2), { id: 2, role: '主管' });
  const third = createStaffAccount(db, createInput(3), { id: 2, role: '主管' });
  const fourth = createStaffAccount(db, createInput(4), { id: 2, role: '主管' });
  const fifth = createStaffAccount(db, createInput(5, 'keeper'), { id: 2, role: '主管' });

  assert.equal(one(db, 'SELECT manager_id FROM staff_profiles WHERE id = ?', [first.profileId]).manager_id, 10);
  assert.deepEqual(
    db.exec('SELECT manager_id, COUNT(*) FROM staff_profiles WHERE employment_status = \'active\' AND manager_id IS NOT NULL GROUP BY manager_id ORDER BY manager_id')[0].values,
    [[10, 1], [20, 4]]
  );
  assert.throws(
    () => createStaffAccount(db, createInput(6), { id: 2, role: '主管' }),
    (error) => error.code === 'ROLE_CAPACITY_FULL' || error.code === 'TEAM_CAPACITY_FULL'
  );
  assert.equal(one(db, 'SELECT manager_id FROM staff_profiles WHERE id = ?', [second.profileId]).manager_id, 20);
  assert.equal(one(db, 'SELECT manager_id FROM staff_profiles WHERE id = ?', [third.profileId]).manager_id, 20);
  assert.equal(one(db, 'SELECT manager_id FROM staff_profiles WHERE id = ?', [fourth.profileId]).manager_id, 20);
  assert.equal(one(db, 'SELECT manager_id FROM staff_profiles WHERE id = ?', [fifth.profileId]).manager_id, 20);
});

test('第 5 名或岗位已满时审批回滚且申请保持 pending', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  createStaffAccount(db, createInput(2), { id: 1, role: '主管' });
  createStaffAccount(db, createInput(3), { id: 1, role: '主管' });
  createStaffAccount(db, createInput(4, 'keeper'), { id: 1, role: '主管' });
  db.run(`INSERT INTO pending_registrations
    (id, phone, password, name, role, community_id, status, created)
    VALUES (99, '13800000999', 'pending-hash', '第五星', 'worker', 'default', 'pending', '2026-08-09')`);

  assert.throws(
    () => approvePendingRegistration(db, 99, { id: 1, role: '主管' }),
    (error) => error.code === 'ROLE_CAPACITY_FULL' || error.code === 'TEAM_CAPACITY_FULL'
  );
  assert.equal(one(db, 'SELECT status FROM pending_registrations WHERE id = 99').status, 'pending');
  assert.equal(one(db, "SELECT COUNT(*) AS total FROM users WHERE phone = '13800000999'").total, 0);
});

test('离职删除账号但保留历史工单和活动的稳定人员引用', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const staff = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  db.run(`UPDATE tickets SET worker = '师傅1', assignee_user_id = ? WHERE id = 'missing'`, [staff.userId]);
  db.run(`INSERT INTO tickets (id, worker, assignee_user_id) VALUES ('history-1', '师傅1', ?)`, [staff.userId]);
  db.run(`INSERT INTO ticket_activity_logs
    (ticket_id, actor_user_id, action, metadata, created_at)
    VALUES ('history-1', ?, 'complete', '{}', '2026-07-01')`, [staff.userId]);
  db.run(`INSERT INTO shift_assignments
    (staff_id, work_date, assignment_type, created_by, updated_at)
    VALUES (?, '2026-07-01', 'work', 1, '2026-07-01'),
           (?, '2026-08-12', 'work', 1, '2026-08-12'),
           (?, '2026-08-13', 'work', 1, '2026-08-13')`, [staff.profileId, staff.profileId, staff.profileId]);
  db.run("INSERT INTO staff_status (name, status) VALUES ('师傅1', 'on')");

  const beforeTickets = one(db, 'SELECT COUNT(*) AS total FROM tickets').total;
  const beforeActivities = one(db, 'SELECT COUNT(*) AS total FROM ticket_activity_logs').total;
  const result = departStaff(db, staff.userId, {
    id: 1, role: '主管', nowIso: '2026-08-12T08:00:00.000+08:00', shanghaiDate: '2026-08-12',
  });

  assert.equal(result.departed, true);
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM users WHERE id = ?', [staff.userId]).total, 0);
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM tickets').total, beforeTickets);
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM ticket_activity_logs').total, beforeActivities);
  assert.deepEqual(
    db.exec("SELECT assignee_user_id, assignee_staff_profile_id FROM tickets WHERE id = 'history-1'")[0].values[0],
    [null, staff.profileId]
  );
  assert.deepEqual(
    db.exec("SELECT actor_user_id, actor_staff_id FROM ticket_activity_logs WHERE ticket_id = 'history-1'")[0].values[0],
    [null, staff.profileId]
  );
  const profile = one(db, 'SELECT * FROM staff_profiles WHERE id = ?', [staff.profileId]);
  assert.equal(profile.user_id, null);
  assert.equal(profile.employment_status, 'departed');
  assert.equal(profile.departed_by_user_id, 1);
  assert.notEqual(profile.phone, '13800000101');
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM shift_assignments WHERE staff_id = ?', [staff.profileId]).total, 1);
  assert.equal(one(db, "SELECT work_date FROM shift_assignments WHERE staff_id = ?", [staff.profileId]).work_date, '2026-07-01');
});

test('离职事务中任一步失败会完整回滚', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const staff = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  db.run(`INSERT INTO tickets (id, worker, assignee_user_id) VALUES ('rollback-1', '师傅1', ?)`, [staff.userId]);
  db.run('ALTER TABLE community_memberships RENAME TO valid_memberships');
  db.run('CREATE TABLE community_memberships (broken TEXT)');

  assert.throws(() => departStaff(db, staff.userId, {
    id: 1, role: '主管', nowIso: '2026-08-12T08:00:00.000+08:00', shanghaiDate: '2026-08-12',
  }));
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM users WHERE id = ?', [staff.userId]).total, 1);
  assert.equal(one(db, 'SELECT user_id FROM staff_profiles WHERE id = ?', [staff.profileId]).user_id, staff.userId);
  assert.equal(one(db, "SELECT assignee_user_id FROM tickets WHERE id = 'rollback-1'").assignee_user_id, staff.userId);
});

test('离职释放名额后可以审批新人', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const first = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  createStaffAccount(db, createInput(2), { id: 1, role: '主管' });
  createStaffAccount(db, createInput(3), { id: 1, role: '主管' });
  createStaffAccount(db, createInput(4, 'keeper'), { id: 1, role: '主管' });
  departStaff(db, first.userId, {
    id: 1, role: '主管', nowIso: '2026-08-12T08:00:00.000+08:00', shanghaiDate: '2026-08-12',
  });
  db.run(`INSERT INTO pending_registrations
    (id, phone, password, name, role, community_id, status, created)
    VALUES (100, '13800000998', 'pending-hash', '新师傅', 'worker', 'default', 'pending', '2026-08-12')`);

  const approved = approvePendingRegistration(db, 100, { id: 1, role: '主管' });
  assert.equal(approved.role, 'worker');
  assert.equal(one(db, 'SELECT status FROM pending_registrations WHERE id = 100').status, 'approved');
});

test('不能让本人或系统唯一主管离职', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  assert.throws(
    () => departStaff(db, 1, { id: 1, role: '主管' }),
    (error) => error.code === 'CANNOT_DEPART_SELF'
  );
  assert.throws(
    () => departStaff(db, 1, { id: 2, role: '主管' }),
    (error) => error.code === 'LAST_SUPERVISOR'
  );
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM users WHERE id = 1').total, 1);
});

test('离职回填只补空稳定身份，不覆盖工单和活动已有的历史档案', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const staff = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  db.run(`INSERT INTO staff_profiles
    (id, name, position, employment_status) VALUES (99, '既有历史身份', '维修师傅', 'departed')`);
  db.run(`INSERT INTO tickets
    (id, worker, assignee_user_id, assignee_staff_profile_id)
    VALUES ('stable-existing', '既有历史身份', ?, 99)`, [staff.userId]);
  db.run(`INSERT INTO ticket_activity_logs
    (ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)
    VALUES ('stable-existing', ?, 99, 'history', '{}', '2026-07-01')`, [staff.userId]);

  departStaff(db, staff.userId, {
    id: 1, role: '主管', nowIso: '2026-08-12T08:00:00.000+08:00', shanghaiDate: '2026-08-12',
  });

  assert.equal(one(db, "SELECT assignee_staff_profile_id FROM tickets WHERE id = 'stable-existing'").assignee_staff_profile_id, 99);
  assert.equal(one(db, "SELECT actor_staff_id FROM ticket_activity_logs WHERE ticket_id = 'stable-existing'").actor_staff_id, 99);
});

test('重复离职幂等返回同一历史档案且不重复写离职审计', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const staff = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  const actor = { id: 1, role: '主管', nowIso: '2026-08-12T08:00:00.000+08:00', shanghaiDate: '2026-08-12' };
  const first = departStaff(db, staff.userId, actor);
  const second = departStaff(db, staff.userId, actor);

  assert.equal(first.departed, true);
  assert.equal(second.alreadyDeparted, true);
  assert.equal(second.profileId, staff.profileId);
  assert.equal(one(db, "SELECT COUNT(*) AS total FROM staff_lifecycle_audit WHERE action = 'depart' AND target_user_id = ?", [staff.userId]).total, 1);
});

test('创建、审批和离职写非敏感生命周期审计', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const created = createStaffAccount(db, createInput(1), { id: 1, role: '主管' });
  db.run(`INSERT INTO pending_registrations
    (id, phone, password, name, role, community_id, status, created)
    VALUES (101, '13800000997', 'sensitive-password-hash', '审计新人', 'worker', 'default', 'pending', '2026-08-12')`);
  const approved = approvePendingRegistration(db, 101, { id: 1, role: '主管' });
  departStaff(db, created.userId, {
    id: 1, role: '主管', nowIso: '2026-08-12T08:00:00.000+08:00', shanghaiDate: '2026-08-12',
  });

  const audits = db.exec(`SELECT actor_user_id, target_user_id, target_staff_profile_id, action, metadata
    FROM staff_lifecycle_audit ORDER BY id`)[0].values;
  assert.deepEqual(audits.map((row) => row[3]), ['create', 'approve', 'depart']);
  assert.ok(audits.every((row) => row[0] === 1));
  assert.equal(audits[0][1], created.userId);
  assert.equal(audits[0][2], created.profileId);
  assert.equal(audits[1][1], approved.userId);
  assert.equal(audits[1][2], approved.profileId);
  const serialized = JSON.stringify(audits);
  assert.equal(serialized.includes('sensitive-password-hash'), false);
  assert.equal(serialized.toLowerCase().includes('token'), false);
});
