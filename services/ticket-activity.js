function detectTicketAction(before, updates) {
  if (!before || !updates) return null;
  if (updates._action === 'urge') return 'urge';
  if (updates._action !== undefined) return null;

  if (updates.worker !== undefined &&
      updates.worker !== before.worker &&
      String(updates.worker || '').trim()) return 'assign';
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

function resolveAssignee(db, workerName, supervisorUserId) {
  const displayName = String(workerName || '').trim();
  if (!displayName || supervisorUserId == null) throw assigneeError();
  const userStatus = tableColumns(db, 'users').has('status')
    ? " AND COALESCE(u.status, 'active') = 'active'"
    : '';
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
        AND sp.user_id IS NOT NULL${userStatus}`,
    [displayName, supervisorUserId]
  );
  if (rows.length !== 1) throw assigneeError();
  return {
    assigneeUserId: Number(rows[0].user_id),
    assigneeStaffProfileId: Number(rows[0].staff_profile_id),
    displayName: String(rows[0].name),
  };
}

function recordTicketActivity(db, {
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
  db.run(
    `INSERT INTO ticket_activity_logs
      (ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ticketId,
      actorUserId == null ? null : actorUserId,
      actorStaffId == null ? null : actorStaffId,
      action,
      metadataJson,
      createdAt || new Date().toISOString(),
    ]
  );
}

module.exports = {
  detectTicketAction,
  resolveAssignee,
  recordTicketActivity,
};
