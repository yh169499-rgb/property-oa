function detectTicketAction(before, updates) {
  if (!before || !updates) return null;
  if (updates._action === 'urge') return 'urge';
  if (updates._action !== undefined) return null;

  const nextWorker = updates.worker === undefined ? undefined : String(updates.worker || '').trim();
  const currentWorker = String(before.worker || '').trim();
  if (nextWorker !== undefined && nextWorker !== currentWorker && nextWorker) return 'assign';
  if (before.status === 'confirm' && updates.status === 'done') return 'approve_complete';
  if (before.status === 'confirm' && updates.status === 'doing' &&
      (updates.rejectReason || updates.reject_reason)) return 'reject';
  if (before.status === 'wait' && updates.status === 'doing') return 'accept';
  if (before.status === 'doing' && updates.status === 'wait') return 'return';
  if ((before.status === 'doing' || before.status === 'pending') &&
      updates.status === 'confirm') return 'submit';
  if (before.status === 'doing' && updates.status === 'pending') return 'suspend';
  if (before.status === 'pending' && updates.status === 'doing') return 'resume';
  return null;
}

function queryRows(db, sql, params) {
  const statement = db.prepare(sql);
  if (params) statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function assigneeError() {
  const error = new Error('处理人不存在、已离职、重名或不属于当前主管团队');
  error.status = 409;
  error.code = 'ASSIGNEE_NOT_ELIGIBLE';
  return error;
}

function tableColumns(db, table) {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return new Set(result[0] ? result[0].values.map((row) => row[1]) : []);
}

function resolveAssignee(db, workerName, supervisorUserId, tenantId) {
  const displayName = String(workerName || '').trim();
  if (!displayName || supervisorUserId == null) throw assigneeError();
  const usersTenantAware = tableColumns(db, 'users').has('tenant_id');
  const profilesTenantAware = tableColumns(db, 'staff_profiles').has('tenant_id');
  const tenantAware = usersTenantAware && profilesTenantAware;
  if (tenantAware && !tenantId) throw assigneeError();
  const userStatus = tableColumns(db, 'users').has('status')
    ? " AND COALESCE(u.status, 'active') = 'active'"
    : '';
  const tenantScope = tenantAware
    ? ` AND COALESCE(sp.tenant_id, '') IN ('', ?)
        AND u.tenant_id = ?
        AND COALESCE(manager.tenant_id, '') IN ('', ?)`
    : '';
  const params = [displayName, supervisorUserId];
  if (tenantAware) params.push(tenantId, tenantId, tenantId);
  const rows = queryRows(
    db,
    `SELECT sp.id AS staff_profile_id, sp.user_id, sp.name
       FROM staff_profiles sp
       JOIN users u ON u.id = sp.user_id
       JOIN staff_profiles manager ON manager.id = sp.manager_id
      WHERE TRIM(sp.name) = ?
        AND COALESCE(sp.employment_status, 'active') = 'active'
        AND manager.user_id = ?
        AND LOWER(TRIM(u.role)) IN ('worker', 'keeper')
        AND sp.user_id IS NOT NULL${userStatus}${tenantScope}`,
    params
  );
  if (rows.length !== 1) throw assigneeError();
  return {
    assigneeUserId: Number(rows[0].user_id),
    assigneeStaffProfileId: Number(rows[0].staff_profile_id),
    displayName: String(rows[0].name),
  };
}

function recordTicketActivity(db, {
  tenantId,
  ticketId,
  actorUserId,
  actorStaffId,
  action,
  metadata,
  createdAt,
}) {
  const metadataJson = metadata == null
    ? '{}'
    : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  const tenantAware = tableColumns(db, 'ticket_activity_logs').has('tenant_id');
  if (tenantAware && !tenantId) throw new Error('ticket activity tenant is required');
  const columns = tenantAware
    ? '(tenant_id, ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)'
    : '(ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)';
  const placeholders = tenantAware ? '(?, ?, ?, ?, ?, ?, ?)' : '(?, ?, ?, ?, ?, ?)';
  const values = [
    ticketId,
    actorUserId == null ? null : actorUserId,
    actorStaffId == null ? null : actorStaffId,
    action,
    metadataJson,
    createdAt || new Date().toISOString(),
  ];
  if (tenantAware) values.unshift(tenantId);
  db.run(`INSERT INTO ticket_activity_logs ${columns} VALUES ${placeholders}`, values);
}

module.exports = {
  detectTicketAction,
  resolveAssignee,
  recordTicketActivity,
};
