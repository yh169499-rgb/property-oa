const { descendantIds } = require('./organization');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function dateParts(value, label = '日期') {
  const match = DATE_RE.exec(String(value || ''));
  if (!match) throw invalidDate(`${label}格式必须为 YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw invalidDate(`${label}不是有效日期`);
  }
  return { year, month, day };
}

function invalidDate(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'INVALID_DATE_RANGE';
  return error;
}

function shanghaiMidnight(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS).toISOString();
}

function shanghaiDateFromInstant(iso) {
  return new Date(Date.parse(iso) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shanghaiDayRange(date) {
  const { year, month, day } = dateParts(date);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    from: shanghaiMidnight(year, month, day),
    toExclusive: shanghaiMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

function shanghaiMonthRange(nowIso = new Date().toISOString()) {
  const instant = new Date(nowIso);
  if (!Number.isFinite(instant.getTime())) throw invalidDate('当前时间不是有效日期');
  const local = new Date(instant.getTime() + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const next = new Date(Date.UTC(year, month, 1));
  return {
    from: shanghaiMidnight(year, month, 1),
    toExclusive: shanghaiMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, 1),
  };
}

function inclusiveDateRange(from, to) {
  const start = dateParts(from, '开始日期');
  const end = dateParts(to, '结束日期');
  const startAt = Date.UTC(start.year, start.month - 1, start.day);
  const endAt = Date.UTC(end.year, end.month - 1, end.day);
  if (startAt > endAt) throw invalidDate('开始日期不能晚于结束日期');
  const next = new Date(endAt + 86400000);
  return {
    from: shanghaiMidnight(start.year, start.month, start.day),
    toExclusive: shanghaiMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || {};
}

function rangeFor(filters = {}) {
  if (filters.from || filters.to) {
    if (!filters.from || !filters.to) throw invalidDate('开始日期和结束日期必须同时提供');
    return inclusiveDateRange(filters.from, filters.to);
  }
  return shanghaiMonthRange(filters.now);
}

function communityClause(filters, column = 't.community_id') {
  return filters.communityId || filters.community_id
    ? { sql: ` AND ${column} = ?`, params: [filters.communityId || filters.community_id] }
    : { sql: '', params: [] };
}

function reportForStaffIds(db, staffIds, filters = {}) {
  const range = rangeFor(filters);
  const ids = [...new Set(staffIds.map(Number).filter(Number.isInteger))];
  const placeholders = ids.map(() => '?').join(',');
  const community = communityClause(filters);
  const noStaff = ids.length === 0;
  const staffPredicate = noStaff
    ? '0'
    : `t.assignee_user_id IN (SELECT user_id FROM staff_profiles WHERE id IN (${placeholders}))`;
  const baseParams = [...ids, ...community.params];

  const received = one(db, `
    SELECT COUNT(*) total
      FROM tickets t
     WHERE ${staffPredicate}${community.sql}
       AND COALESCE(NULLIF(t.assigned_at, ''), t.created) >= ?
       AND COALESCE(NULLIF(t.assigned_at, ''), t.created) < ?`,
  [...baseParams, range.from, range.toExclusive]);

  const completedRows = rows(db, `
    SELECT t.created, t.assigned_at, t.finished, t.estimated_hours
      FROM tickets t
     WHERE ${staffPredicate}${community.sql}
       AND t.status = 'done' AND NULLIF(t.finished, '') IS NOT NULL
       AND t.finished >= ? AND t.finished < ?`,
  [...baseParams, range.from, range.toExclusive]);
  const durations = completedRows.map((ticket) => (
    Date.parse(ticket.finished) - Date.parse(ticket.assigned_at || ticket.created)
  ) / 3600000).filter((hours) => Number.isFinite(hours) && hours >= 0);
  const withSla = completedRows.filter((ticket) => Number(ticket.estimated_hours) > 0);
  const onTime = withSla.filter((ticket) => (
    Date.parse(ticket.finished) - Date.parse(ticket.assigned_at || ticket.created)
  ) <= Number(ticket.estimated_hours) * 3600000).length;

  const current = one(db, `
    SELECT
      SUM(CASE WHEN t.status = 'doing' THEN 1 ELSE 0 END) doing,
      SUM(CASE WHEN t.status IN ('pending', 'wait') THEN 1 ELSE 0 END) pending
      FROM tickets t WHERE ${staffPredicate}${community.sql}`,
  baseParams);
  const attendanceRows = noStaff ? [] : rows(db, `
    SELECT status, COUNT(*) count
      FROM attendance_records
     WHERE staff_id IN (${placeholders})
       AND work_date >= ? AND work_date < ?
     GROUP BY status`,
  [...ids, shanghaiDateFromInstant(range.from), shanghaiDateFromInstant(range.toExclusive)]);
  const attendance = { actualDays: 0, normal: 0, late: 0, early: 0, leave: 0, absent: 0, missing: 0 };
  for (const item of attendanceRows) {
    attendance.actualDays += Number(item.count);
    if (Object.hasOwn(attendance, item.status)) attendance[item.status] = Number(item.count);
    else if (item.status === 'early_leave') attendance.early = Number(item.count);
    else if (item.status === 'missing_punch') attendance.missing = Number(item.count);
  }
  return {
    range,
    received: { total: Number(received.total || 0), basis: 'assigned_at_or_created' },
    completed: {
      total: completedRows.length,
      averageHours: durations.length
        ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1))
        : 0,
      onTimeRate: withSla.length ? Number(((onTime / withSla.length) * 100).toFixed(1)) : 0,
    },
    current: { doing: Number(current.doing || 0), pending: Number(current.pending || 0) },
    attendance,
  };
}

function getStaffReport(db, staffId, filters = {}) {
  const id = Number(staffId);
  if (!Number.isInteger(id)) {
    const error = new Error('人员 ID 无效');
    error.status = 400;
    error.code = 'INVALID_STAFF_ID';
    throw error;
  }
  const profile = rows(db, 'SELECT * FROM staff_profiles WHERE id = ?', [id])[0];
  if (!profile) {
    const error = new Error('人员档案不存在');
    error.status = 404;
    error.code = 'PROFILE_NOT_FOUND';
    throw error;
  }
  return { staff: profile, ...reportForStaffIds(db, [id], filters) };
}

function getManagerReport(db, staffId, filters = {}) {
  const manager = getStaffReport(db, staffId, filters).staff;
  const profiles = rows(db, 'SELECT id, manager_id FROM staff_profiles');
  const teamIds = descendantIds(profiles, manager.id).map(Number);
  const range = rangeFor(filters);
  const actions = rows(db, `
    SELECT action, COUNT(*) count
      FROM ticket_activity_logs
     WHERE actor_staff_id = ? AND created_at >= ? AND created_at < ?
     GROUP BY action`,
  [Number(manager.id), range.from, range.toExclusive]);
  return {
    manager,
    range,
    personalActions: {
      total: actions.reduce((sum, item) => sum + Number(item.count), 0),
      byAction: Object.fromEntries(actions.map((item) => [item.action, Number(item.count)])),
    },
    team: { staffIds: teamIds, ...reportForStaffIds(db, teamIds, filters) },
  };
}

function getDashboardStats(db, filters = {}) {
  const range = shanghaiMonthRange(filters.now);
  const community = communityClause(filters);
  const monthly = rows(db, `
    SELECT type, status, created, finished, estimated_hours
      FROM tickets t
     WHERE t.created >= ? AND t.created < ?${community.sql}`,
  [range.from, range.toExclusive, ...community.params]);
  const byType = { repair: 0, complaint: 0, help: 0 };
  for (const ticket of monthly) byType[ticket.type] = (byType[ticket.type] || 0) + 1;
  const done = rows(db, `
    SELECT created, finished, estimated_hours
      FROM tickets t
     WHERE t.status = 'done' AND NULLIF(t.finished, '') IS NOT NULL
       AND t.finished >= ? AND t.finished < ?${community.sql}`,
  [range.from, range.toExclusive, ...community.params]);
  const durations = done.map((ticket) => (
    Date.parse(ticket.finished) - Date.parse(ticket.created)
  ) / 3600000).filter((hours) => Number.isFinite(hours) && hours >= 0);
  const withSla = done.filter((ticket) => Number(ticket.estimated_hours) > 0);
  const onTime = withSla.filter((ticket) => (
    Date.parse(ticket.finished) - Date.parse(ticket.created)
  ) <= Number(ticket.estimated_hours) * 3600000).length;
  const urgent = one(db, `
    SELECT COUNT(*) total FROM tickets t
     WHERE t.priority = 'urgent' AND t.status <> 'done'${community.sql}`,
  community.params);
  const today = shanghaiDayRange(new Date((new Date(filters.now || Date.now())).getTime() + SHANGHAI_OFFSET_MS)
    .toISOString().slice(0, 10));
  const managerActions = one(db, `
    SELECT COUNT(*) total FROM ticket_activity_logs
     WHERE created_at >= ? AND created_at < ?`, [today.from, today.toExclusive]);
  const attendance = one(db, `
    SELECT COUNT(*) actual FROM attendance_records
     WHERE work_date = ?`, [shanghaiDateFromInstant(today.from)]);
  return {
    range,
    monthTotal: monthly.length,
    byType,
    urgentPending: Number(urgent.total || 0),
    averageHours: durations.length
      ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1))
      : 0,
    onTimeRate: withSla.length ? Number(((onTime / withSla.length) * 100).toFixed(1)) : 0,
    todayManagerActions: Number(managerActions.total || 0),
    teamAttendance: { actual: Number(attendance.actual || 0) },
  };
}

module.exports = {
  shanghaiDayRange,
  shanghaiMonthRange,
  inclusiveDateRange,
  getDashboardStats,
  getStaffReport,
  getManagerReport,
};
