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

function tableExists(db, table) {
  const result = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]);
  return Boolean(result[0]?.values?.length);
}

const ACTION_TITLES = {
  create: '工单创建',
  assign: '主管派单',
  accept: '开始处理',
  submit: '提交处理结果',
  approve_complete: '主管确认完成',
  reject: '主管驳回',
  return: '处理人退回',
  suspend: '工单搁置',
  resume: '恢复处理',
  urge: '主管催办',
  platform_update: '管理平台更新',
};

function parseMetadata(value) {
  try { return JSON.parse(value || '{}') || {}; } catch (_) { return {}; }
}

function actorName(db, activity) {
  if (activity.actor_staff_id != null && tableExists(db, 'staff_profiles')) {
    const match = queryRows(db, 'SELECT name FROM staff_profiles WHERE id = ? LIMIT 1', [activity.actor_staff_id])[0];
    if (match?.name) return String(match.name);
  }
  if (activity.actor_user_id != null && tableExists(db, 'users')) {
    const match = queryRows(db, 'SELECT name FROM users WHERE id = ? LIMIT 1', [activity.actor_user_id])[0];
    if (match?.name) return String(match.name);
  }
  return '系统';
}

function timelineDetail(action, metadata) {
  if (action === 'reject') return metadata.rejectReason || metadata.reject_reason || '';
  if (action === 'suspend') return metadata.suspendReason || metadata.reason || '';
  if (action === 'return') return metadata.rejectReason || metadata.reject_reason || metadata.reason || '';
  return '';
}

function buildTicketTimeline(db, ticket) {
  if (!ticket) return [];
  const activityColumns = tableExists(db, 'ticket_activity_logs')
    ? tableColumns(db, 'ticket_activity_logs')
    : new Set();
  const tenantAware = activityColumns.has('tenant_id');
  const activityOrder = activityColumns.has('created_at')
    ? 'created_at ASC, id ASC'
    : 'id ASC';
  const activities = tableExists(db, 'ticket_activity_logs')
    ? queryRows(
      db,
      `SELECT * FROM ticket_activity_logs WHERE ticket_id = ?${tenantAware ? ' AND tenant_id = ?' : ''}
       ORDER BY ${activityOrder}`,
      tenantAware ? [ticket.id, ticket.tenant_id] : [ticket.id]
    )
    : [];
  const steps = activities.filter((activity) => activity.action).map((activity) => {
    const metadata = parseMetadata(activity.metadata);
    return {
      action: activity.action,
      title: ACTION_TITLES[activity.action] || activity.action,
      who: actorName(db, activity),
      time: activity.created_at,
      detail: timelineDetail(activity.action, metadata),
    };
  });
  const actions = new Set(steps.map((step) => step.action));
  if (ticket.created && !actions.has('create')) {
    steps.push({ action: 'create', title: ACTION_TITLES.create, who: '系统', time: ticket.created, detail: '' });
  }
  if (ticket.assigned_at && ticket.worker && !actions.has('assign')) {
    steps.push({ action: 'assign', title: ACTION_TITLES.assign, who: ticket.worker, time: ticket.assigned_at, detail: '' });
  }
  if (ticket.finished && !actions.has('approve_complete')) {
    steps.push({ action: 'approve_complete', title: ACTION_TITLES.approve_complete, who: '主管', time: ticket.finished, detail: '' });
  }
  return steps.sort((left, right) => {
    const timeDifference = (Date.parse(left.time || '') || 0) - (Date.parse(right.time || '') || 0);
    if (timeDifference) return timeDifference;
    const order = ['create', 'assign', 'accept', 'suspend', 'resume', 'return', 'submit', 'reject', 'approve_complete'];
    return order.indexOf(left.action) - order.indexOf(right.action);
  });
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
  buildTicketTimeline,
};
