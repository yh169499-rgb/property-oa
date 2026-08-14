const TEAM_LIMITS = Object.freeze({ total: 4, worker: 3, keeper: 1 });
const { MANAGER_ROLES } = require('./roles');

const STAFF_ROLE_ALIASES = new Map([
  ['worker', 'worker'],
  ['维修工', 'worker'],
  ['维修师傅', 'worker'],
  ['keeper', 'keeper'],
  ['物业管家', 'keeper'],
  ['管家', 'keeper'],
]);

function normalizedStaffRole(roleOrPosition) {
  const value = String(roleOrPosition || '').trim().toLowerCase();
  const exact = STAFF_ROLE_ALIASES.get(value);
  if (exact) return exact;
  if (value.includes('维修')) return 'worker';
  if (value.includes('管家')) return 'keeper';
  return null;
}

function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function teamUsage(db, managerProfileId, options = {}) {
  const params = [managerProfileId];
  let exclusion = '';
  if (options.excludeProfileId !== undefined && options.excludeProfileId !== null) {
    exclusion = ' AND id <> ?';
    params.push(options.excludeProfileId);
  }

  const profiles = queryAll(db, `
    SELECT position
    FROM staff_profiles
    WHERE manager_id = ?
      AND employment_status = 'active'
      ${exclusion}
  `, params);

  const usage = {
    total: profiles.length,
    totalLimit: TEAM_LIMITS.total,
    worker: 0,
    workerLimit: TEAM_LIMITS.worker,
    keeper: 0,
    keeperLimit: TEAM_LIMITS.keeper,
  };
  for (const profile of profiles) {
    const role = normalizedStaffRole(profile.position);
    if (role) usage[role] += 1;
  }
  return usage;
}

function capacityError(message, code, usage, role) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  error.details = { usage, role };
  return error;
}

function assertTeamCapacity(db, managerProfileId, roleOrPosition, options = {}) {
  const role = normalizedStaffRole(roleOrPosition);
  if (!role) {
    const error = new Error('不支持的人员岗位');
    error.status = 400;
    error.code = 'INVALID_STAFF_ROLE';
    error.details = { role: roleOrPosition };
    throw error;
  }

  const usage = teamUsage(db, managerProfileId, options);
  if (usage[role] >= TEAM_LIMITS[role]) {
    throw capacityError('该岗位直属在职人员已满', 'ROLE_CAPACITY_FULL', usage, role);
  }
  if (usage.total >= TEAM_LIMITS.total) {
    throw capacityError('主管直属在职人员已满', 'TEAM_CAPACITY_FULL', usage, role);
  }
  return usage;
}

function findSoleSupervisorProfile(db) {
  const activeProfiles = queryAll(db, `
    SELECT id, name, position, manager_id, employment_status
    FROM staff_profiles
    WHERE employment_status = 'active'
    ORDER BY id
  `);
  const profiles = activeProfiles.filter((profile) => (
    MANAGER_ROLES.has(String(profile.position || '').trim().toLowerCase())
  ));
  if (profiles.length === 1) return profiles[0];

  const error = new Error(
    profiles.length === 0 ? '未找到在职主管档案' : '存在多名在职主管档案'
  );
  error.status = profiles.length === 0 ? 404 : 409;
  error.code = profiles.length === 0
    ? 'SUPERVISOR_PROFILE_NOT_FOUND'
    : 'MULTIPLE_SUPERVISOR_PROFILES';
  error.details = { count: profiles.length };
  throw error;
}

function findSupervisorProfile(db, userId) {
  const profile = queryAll(db, `
    SELECT id, user_id, name, position, manager_id, employment_status
    FROM staff_profiles
    WHERE user_id = ?
      AND employment_status = 'active'
    LIMIT 1
  `, [userId]).find((candidate) => (
    MANAGER_ROLES.has(String(candidate.position || '').trim().toLowerCase())
  ));
  if (profile) return profile;

  const error = new Error('未找到当前主管档案');
  error.status = 404;
  error.code = 'SUPERVISOR_PROFILE_NOT_FOUND';
  error.details = { userId };
  throw error;
}

module.exports = {
  TEAM_LIMITS,
  normalizedStaffRole,
  teamUsage,
  assertTeamCapacity,
  findSoleSupervisorProfile,
  findSupervisorProfile,
};
