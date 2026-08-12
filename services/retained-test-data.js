const bcrypt = require('bcryptjs');
const { ensureWorkforceSchema } = require('../workforce-schema');

const RETAINED_ACCOUNTS = Object.freeze([
  { phone: '13800000001', name: '主管', role: '主管', position: '主管', birthMonth: '1988-06', joinDate: '2021-03-15', skill: '团队管理' },
  { phone: '13800000002', name: '张师傅', role: 'worker', position: '维修师傅', birthMonth: '1985-02', joinDate: '2022-04-08', skill: '水暖' },
  { phone: '13800000003', name: '李师傅', role: 'worker', position: '维修师傅', birthMonth: '1987-07', joinDate: '2022-07-18', skill: '电路' },
  { phone: '13800000004', name: '王师傅', role: 'worker', position: '维修师傅', birthMonth: '1990-11', joinDate: '2023-02-10', skill: '电器' },
  { phone: '13800000005', name: '赵师傅', role: 'worker', position: '维修师傅', birthMonth: '1989-09', joinDate: '2023-06-20', skill: '门窗' },
  { phone: '13800000006', name: '陈管家', role: 'keeper', position: '物业管家', birthMonth: '1992-03', joinDate: '2022-09-12', skill: '客户服务' },
  { phone: '13800000007', name: '周管家', role: 'keeper', position: '物业管家', birthMonth: '1993-12', joinDate: '2024-01-08', skill: '社区协调' },
]);

const MOCK_COMMUNITY = Object.freeze({
  id: 'mock-e2e-community',
  name: '全流程测试小区',
  address: '模拟数据专用，不用于真实业务',
});

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function tableExists(db, table) {
  return Boolean(one(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]));
}

function planRetainedTestData(db) {
  const retainedPhones = new Set(RETAINED_ACCOUNTS.map(account => account.phone));
  const users = tableExists(db, 'users') ? rows(db, 'SELECT phone FROM users') : [];
  return {
    summary: {
      retainedAccounts: RETAINED_ACCOUNTS.length,
      disabledAccounts: users.filter(user => !retainedPhones.has(String(user.phone))).length,
    },
  };
}

function requireMigrationOptions(options = {}) {
  if (!options.password) throw new Error('缺少 RETAINED_TEST_PASSWORD');
  const now = new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('迁移时间无效');
  return { ...options, now, nowIso: now.toISOString() };
}

function upsertRetainedUsers(db, password) {
  const users = new Map();
  for (const account of RETAINED_ACCOUNTS) {
    let user = one(db, 'SELECT * FROM users WHERE phone = ?', [account.phone]);
    const passwordHash = user && bcrypt.compareSync(password, String(user.password || ''))
      ? user.password
      : bcrypt.hashSync(password, 10);
    if (user) {
      db.run(`UPDATE users
        SET password = ?, name = ?, role = ?, status = 'active'
        WHERE id = ?`, [passwordHash, account.name, account.role, user.id]);
    } else {
      db.run(`INSERT INTO users (phone, password, name, role, status)
        VALUES (?, ?, ?, ?, 'active')`, [account.phone, passwordHash, account.name, account.role]);
    }
    user = one(db, 'SELECT * FROM users WHERE phone = ?', [account.phone]);
    users.set(account.phone, user);
  }
  return users;
}

function disableOtherUsers(db, retainedPhones, nowIso) {
  const inactiveUsers = rows(
    db,
    `SELECT id, name FROM users WHERE phone NOT IN (${retainedPhones.map(() => '?').join(', ')})`,
    retainedPhones
  );
  if (!inactiveUsers.length) return;
  const userIds = inactiveUsers.map(user => Number(user.id));
  const placeholders = userIds.map(() => '?').join(', ');
  const profiles = rows(db, `SELECT id, name FROM staff_profiles WHERE user_id IN (${placeholders})`, userIds);
  db.run(`UPDATE users SET status = 'disabled' WHERE id IN (${placeholders})`, userIds);
  if (!profiles.length) return;
  const profileIds = profiles.map(profile => Number(profile.id));
  const profilePlaceholders = profileIds.map(() => '?').join(', ');
  db.run(`UPDATE staff_profiles SET employment_status = 'inactive', updated_at = ?
    WHERE id IN (${profilePlaceholders})`, [nowIso, ...profileIds]);
  db.run(`DELETE FROM community_memberships WHERE staff_profile_id IN (${profilePlaceholders})`, profileIds);
  db.run(`DELETE FROM shift_assignments WHERE staff_id IN (${profilePlaceholders})`, profileIds);
  db.run(`DELETE FROM attendance_records WHERE staff_id IN (${profilePlaceholders})`, profileIds);
  if (tableExists(db, 'attendance_change_logs')) {
    db.run('DELETE FROM attendance_change_logs WHERE attendance_id NOT IN (SELECT id FROM attendance_records)');
  }
  if (tableExists(db, 'staff_status')) {
    const names = profiles.map(profile => String(profile.name || '')).filter(Boolean);
    if (names.length) {
      db.run(`DELETE FROM staff_status WHERE name IN (${names.map(() => '?').join(', ')})`, names);
    }
  }
}

function upsertProfiles(db, users, nowIso) {
  const profiles = new Map();
  for (const account of RETAINED_ACCOUNTS) {
    const user = users.get(account.phone);
    let profile = one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
    if (!profile) {
      db.run(`INSERT INTO staff_profiles
        (user_id, name, birth_month, join_date, phone, position, skill,
         employment_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [
        user.id, account.name, account.birthMonth, account.joinDate, account.phone,
        account.position, account.skill, nowIso, nowIso,
      ]);
    } else {
      db.run(`UPDATE staff_profiles SET
        name = ?, birth_month = COALESCE(NULLIF(birth_month, ''), ?),
        join_date = COALESCE(NULLIF(join_date, ''), ?), phone = ?, position = ?,
        skill = COALESCE(NULLIF(skill, ''), ?), employment_status = 'active', updated_at = ?
        WHERE id = ?`, [
        account.name, account.birthMonth, account.joinDate, account.phone,
        account.position, account.skill, nowIso, profile.id,
      ]);
    }
    profile = one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
    profiles.set(account.phone, profile);
  }
  const supervisorId = Number(profiles.get(RETAINED_ACCOUNTS[0].phone).id);
  db.run('UPDATE staff_profiles SET manager_id = NULL WHERE id = ?', [supervisorId]);
  const subordinateIds = RETAINED_ACCOUNTS.slice(1).map(account => Number(profiles.get(account.phone).id));
  db.run(`UPDATE staff_profiles SET manager_id = ?
    WHERE id IN (${subordinateIds.map(() => '?').join(', ')})`, [supervisorId, ...subordinateIds]);
  return profiles;
}

function upsertCommunitiesAndMemberships(db, profiles, supervisorUserId, nowIso) {
  if (!one(db, "SELECT id FROM communities WHERE id = 'default'")) {
    db.run("INSERT INTO communities (id, name, address, created) VALUES ('default', '默认小区', '', ?)", [nowIso]);
  }
  if (!one(db, 'SELECT id FROM communities WHERE id = ?', [MOCK_COMMUNITY.id])) {
    db.run('INSERT INTO communities (id, name, address, created) VALUES (?, ?, ?, ?)', [
      MOCK_COMMUNITY.id, MOCK_COMMUNITY.name, MOCK_COMMUNITY.address, nowIso,
    ]);
  } else {
    db.run('UPDATE communities SET name = ?, address = ? WHERE id = ?', [
      MOCK_COMMUNITY.name, MOCK_COMMUNITY.address, MOCK_COMMUNITY.id,
    ]);
  }
  for (const account of RETAINED_ACCOUNTS) {
    const profileId = Number(profiles.get(account.phone).id);
    db.run(`INSERT OR IGNORE INTO community_memberships
      (community_id, staff_profile_id, created_at, created_by_user_id)
      VALUES ('default', ?, ?, ?)`, [profileId, nowIso, supervisorUserId]);
  }
  for (const phone of ['13800000001', '13800000002', '13800000006']) {
    db.run(`INSERT OR IGNORE INTO community_memberships
      (community_id, staff_profile_id, created_at, created_by_user_id)
      VALUES (?, ?, ?, ?)`, [MOCK_COMMUNITY.id, profiles.get(phone).id, nowIso, supervisorUserId]);
  }
}

function migrateRetainedTestData(db, rawOptions = {}) {
  const options = requireMigrationOptions(rawOptions);
  ensureWorkforceSchema(db);
  const planned = planRetainedTestData(db);
  db.run('BEGIN TRANSACTION');
  try {
    const phones = RETAINED_ACCOUNTS.map(account => account.phone);
    const users = upsertRetainedUsers(db, options.password);
    disableOtherUsers(db, phones, options.nowIso);
    const profiles = upsertProfiles(db, users, options.nowIso);
    const supervisorUserId = Number(users.get(phones[0]).id);
    upsertCommunitiesAndMemberships(db, profiles, supervisorUserId, options.nowIso);
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
    throw error;
  }
  return { summary: planned.summary };
}

module.exports = {
  RETAINED_ACCOUNTS,
  MOCK_COMMUNITY,
  planRetainedTestData,
  migrateRetainedTestData,
};

