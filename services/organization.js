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

function updateManager(db, staffId, managerId) {
  const staff = normalizeId(staffId);
  const manager = normalizeId(managerId);
  const profiles = rowsFrom(db, 'SELECT id, manager_id FROM staff_profiles');
  if (!profiles.some((profile) => normalizeId(profile.id) === staff)) {
    const error = new Error('人员档案不存在');
    error.status = 404;
    error.code = 'PROFILE_NOT_FOUND';
    error.details = { staffId: staff };
    throw error;
  }
  if (
    manager !== null
    && !profiles.some((profile) => normalizeId(profile.id) === manager)
  ) {
    const error = new Error('直属上级档案不存在');
    error.status = 404;
    error.code = 'MANAGER_NOT_FOUND';
    error.details = { managerId: manager };
    throw error;
  }
  const path = cyclePath(profiles, staff, manager);
  if (path) {
    const error = new Error('不能把本人或下级设为直属上级');
    error.status = 409;
    error.code = 'ORGANIZATION_CYCLE';
    error.details = { staffId: staff, managerId: manager, path };
    throw error;
  }
  db.run(
    'UPDATE staff_profiles SET manager_id = ?, updated_at = ? WHERE id = ?',
    [manager, new Date().toISOString(), staff]
  );
  return rowsFrom(db, 'SELECT * FROM staff_profiles WHERE id = ?', [staff])[0] || null;
}

module.exports = {
  descendantIds,
  wouldCreateCycle,
  buildOrganizationTree,
  updateManager,
};
