function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function dispatchError(message, code, conflictingTicketIds = []) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.conflictingTicketIds = conflictingTicketIds;
  return error;
}

function shanghaiDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw dispatchError('派单时间无效', 'INVALID_ASSIGNMENT_TIME');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function assertDispatchAvailable(db, {
  staffProfileId,
  assignedAt,
  estimatedHours,
  excludeTicketId = null,
}) {
  const staffId = Number(staffProfileId);
  const startMs = Date.parse(assignedAt);
  const hours = Number(estimatedHours) > 0 ? Number(estimatedHours) : 1;
  if (!Number.isInteger(staffId) || staffId <= 0 || !Number.isFinite(startMs)) {
    throw dispatchError('派单人员或时间无效', 'INVALID_ASSIGNMENT_TIME');
  }
  const endMs = startMs + hours * 3600000;
  const workDate = shanghaiDate(startMs);
  const shifts = queryAll(db, `SELECT * FROM shift_assignments
    WHERE staff_id = ? AND work_date IN (?, ?) ORDER BY work_date DESC`, [
    staffId, workDate, previousDate(workDate),
  ]);
  const current = shifts.find(shift => shift.work_date === workDate);
  if (current && current.assignment_type === 'leave') {
    throw dispatchError('该员工当天已请假，不能派单', 'ASSIGNEE_ON_LEAVE');
  }
  if (current && current.assignment_type === 'rest') {
    throw dispatchError('该员工当天休息，不能派单', 'ASSIGNEE_RESTING');
  }
  const containingWorkShift = shifts.find(shift => shift.assignment_type === 'work'
    && Number.isFinite(Date.parse(shift.start_at))
    && Number.isFinite(Date.parse(shift.end_at))
    && startMs >= Date.parse(shift.start_at)
    && endMs <= Date.parse(shift.end_at));

  if (!containingWorkShift) {
    if (shifts.some(shift => shift.assignment_type === 'work')) {
      throw dispatchError('工单时间必须完整处于员工班次内', 'ASSIGNMENT_OUTSIDE_SHIFT');
    }
    throw dispatchError('该员工当天未排班，不能派单', 'ASSIGNEE_NOT_SCHEDULED');
  }

  const tickets = queryAll(db, `SELECT id, assigned_at, estimated_hours
    FROM tickets
    WHERE assignee_staff_profile_id = ?
      AND COALESCE(status, 'wait') <> 'done'
      AND assigned_at IS NOT NULL
      AND assigned_at <> ''`, [staffId]);
  const conflicts = tickets.filter(ticket => {
    if (excludeTicketId != null && String(ticket.id) === String(excludeTicketId)) return false;
    const ticketStart = Date.parse(ticket.assigned_at);
    const ticketHours = Number(ticket.estimated_hours) > 0 ? Number(ticket.estimated_hours) : 1;
    const ticketEnd = ticketStart + ticketHours * 3600000;
    return Number.isFinite(ticketStart) && startMs < ticketEnd && ticketStart < endMs;
  }).map(ticket => String(ticket.id));
  if (conflicts.length) {
    throw dispatchError(
      `派单时间与工单 ${conflicts.join('、')} 重叠`,
      'ASSIGNMENT_TIME_CONFLICT',
      conflicts
    );
  }

  return {
    shift: containingWorkShift,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
  };
}

module.exports = { assertDispatchAvailable, dispatchError, shanghaiDate };
