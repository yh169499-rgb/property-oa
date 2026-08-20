const { MANAGER_ROLES } = require('./roles');
const { assertTeamCapacity, normalizedStaffRole, isTenantCapacity } = require('./team-capacity');
const { assertTenantWriteTarget } = require('./tenant-context');

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) ? id : value;
}

function descendantIds(profiles, managerId) {
  const result = [];
  const queue = [normalizeId(managerId)];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    for (const profile of profiles) {
      const id = normalizeId(profile.id);
      if (normalizeId(profile.manager_id) === current && !seen.has(id)) {
        seen.add(id);
        result.push(id);
        queue.push(id);
      }
    }
  }
  return result;
}

function cyclePath(profiles, staffId, managerId) {
  const staff = normalizeId(staffId);
  const manager = normalizeId(managerId);
  if (manager === null) return null;
  if (staff === manager) return [staff, staff];

  const parentById = new Map(
    profiles.map((profile) => [
      normalizeId(profile.id),
      normalizeId(profile.manager_id),
    ])
  );
  const upward = [manager];
  const seen = new Set();
  let current = manager;
  while (current !== null && !seen.has(current)) {
    if (current === staff) return [staff, ...upward.slice(0, -1).reverse(), staff];
    seen.add(current);
    current = parentById.get(current) ?? null;
    if (current !== null) upward.push(current);
  }

  const descendants = descendantIds(profiles, staff);
  if (!descendants.includes(manager)) return null;
  const byManager = new Map();
  for (const profile of profiles) {
    const parent = normalizeId(profile.manager_id);
    const id = normalizeId(profile.id);
    if (!byManager.has(parent)) byManager.set(parent, []);
    byManager.get(parent).push(id);
  }
  const queue = [[staff]];
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    for (const child of byManager.get(last) || []) {
      const next = [...path, child];
      if (child === manager) return [...next, staff];
      queue.push(next);
    }
  }
  return [staff, manager, staff];
}

function wouldCreateCycle(profiles, staffId, managerId) {
  return cyclePath(profiles, staffId, managerId) !== null;
}

function buildOrganizationTree(profiles) {
  const nodes = new Map(
    profiles.map((profile) => [
      normalizeId(profile.id),
      { ...profile, id: normalizeId(profile.id), manager_id: normalizeId(profile.manager_id), children: [] },
    ])
  );
  const roots = [];
  const unassigned = [];

  for (const node of nodes.values()) {
    const parent = nodes.get(node.manager_id);
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const tree = roots.filter((node) => node.children.length > 0);
  for (const node of roots) {
    if (!node.children.length) unassigned.push(node);
  }
  return { tree, unassigned };
}

function rowsFrom(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function updateManager(db, tenantId, staffId, managerId, options = {}) {
  const staff = normalizeId(staffId);
  const manager = normalizeId(managerId);
  assertTenantWriteTarget(db, {
    table: 'staff_profiles', id: staff, tenantId,
    notFoundCode: 'PROFILE_NOT_FOUND', notFoundMessage: '人员档案不存在',
  });
  if (manager !== null) {
    assertTenantWriteTarget(db, {
      table: 'staff_profiles', id: manager, tenantId,
      notFoundCode: 'MANAGER_NOT_FOUND', notFoundMessage: '直属上级档案不存在',
    });
  }
  const profiles = rowsFrom(
    db,
    `SELECT id, position, manager_id, employment_status FROM staff_profiles
     WHERE tenant_id = ?`,
    [tenantId]
  );
  const existingProfile = profiles.find((profile) => normalizeId(profile.id) === staff);
  const managerProfile = profiles.find((profile) => normalizeId(profile.id) === manager);
  const path = cyclePath(profiles, staff, manager);
  if (path) {
    const error = new Error('不能把本人或下级设为直属上级');
    error.status = 409;
    error.code = 'ORGANIZATION_CYCLE';
    error.details = { staffId: staff, managerId: manager, path };
    throw error;
  }
  const candidate = { ...existingProfile, ...(options.profile || {}), manager_id: manager };
  const staffRole = normalizedStaffRole(candidate.position);
  if (candidate.employment_status === 'active' && manager !== null && !staffRole) {
    const isSupervisor = MANAGER_ROLES.has(
      String(candidate.position || '').trim().toLowerCase()
    );
    if (!isSupervisor) {
      const error = new Error('在职直属人员必须使用维修或管家岗位');
      error.status = 400;
      error.code = 'INVALID_STAFF_ROLE';
      error.details = { role: candidate.position };
      throw error;
    }
  }
  const isActiveStaff = candidate.employment_status === 'active' && staffRole;
  if (isActiveStaff && manager === null) {
    const error = new Error('在职普通员工必须绑定直属主管');
    error.status = 409;
    error.code = 'ACTIVE_STAFF_MANAGER_REQUIRED';
    error.details = { staffId: staff };
    throw error;
  }
  if (isActiveStaff) {
    const managerIsActive = managerProfile.employment_status === 'active';
    const managerIsSupervisor = MANAGER_ROLES.has(
      String(managerProfile.position || '').trim().toLowerCase()
    );
    if (!managerIsActive || !managerIsSupervisor) {
      const error = new Error('直属上级必须是在职主管');
      error.status = 409;
      error.code = 'INVALID_ACTIVE_MANAGER';
      error.details = { managerId: manager };
      throw error;
    }
    if (isTenantCapacity(db)) {
      assertTeamCapacity(db, tenantId, { excludeProfileId: staff });
    } else {
      assertTeamCapacity(db, manager, staffRole, { excludeProfileId: staff });
    }
  }
  db.run(
    `UPDATE staff_profiles SET manager_id = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [manager, new Date().toISOString(), staff, tenantId]
  );
  return rowsFrom(
    db,
    'SELECT * FROM staff_profiles WHERE id = ? AND tenant_id = ?',
    [staff, tenantId]
  )[0] || null;
}

module.exports = {
  descendantIds,
  wouldCreateCycle,
  buildOrganizationTree,
  updateManager,
};
