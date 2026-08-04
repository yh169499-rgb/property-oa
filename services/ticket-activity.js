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

function resolveAssigneeUserId(db, workerName) {
  if (!workerName || !String(workerName).trim()) return null;
  const rows = queryRows(
    db,
    'SELECT user_id FROM staff_profiles WHERE name = ?',
    [String(workerName).trim()]
  );
  return rows.length === 1 && rows[0].user_id != null ? rows[0].user_id : null;
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
  resolveAssigneeUserId,
  recordTicketActivity,
};
