const { descendantIds } = require('./organization');
const { isManagerRole } = require('./roles');

function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function calendarError(message, code = 'INVALID_CALENDAR_REQUEST', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function shanghaiDayRange(date) {
  const fromMs = Date.parse(`${date}T00:00:00+08:00`);
  return {
    from: new Date(fromMs).toISOString(),
    toExclusive: new Date(fromMs + 86400000).toISOString(),
  };
}

function estimateTicketWindow(ticket, staffHistory = [], now = new Date()) {
  const startAt = ticket.assigned_at || ticket.assignedAt || ticket.created
    || (now instanceof Date ? now.toISOString() : now);
  let historicalAverage = 1;
  if (Array.isArray(staffHistory)) {
    const completedHours = staffHistory
      .map((item) => {
        const start = Date.parse(item.assigned_at || item.assignedAt || item.created);
        const end = Date.parse(item.finished);
        return (end - start) / 3600000;
      })
      .filter((hours) => Number.isFinite(hours) && hours > 0);
    if (completedHours.length) {
      historicalAverage = completedHours.reduce((sum, hours) => sum + hours, 0)
        / completedHours.length;
    }
  } else {
    const avgMinutes = Number(staffHistory && staffHistory.avgMinutes);
    if (avgMinutes > 0) historicalAverage = Math.round((avgMinutes / 60) * 1e6) / 1e6;
  }
  const explicitHours = Number(ticket.estimated_hours ?? ticket.estimatedHours);
  const durationHours = explicitHours > 0 ? explicitHours : historicalAverage;
  return {
    startAt,
    endAt: new Date(Date.parse(startAt) + durationHours * 3600000).toISOString(),
    estimatedHours: durationHours,
  };
}

function detectCalendarConflicts(events) {
  const byStaff = new Map();
  for (const event of events) {
    if (!byStaff.has(event.staffId)) byStaff.set(event.staffId, []);
    byStaff.get(event.staffId).push(event);
  }
  const conflicts = [];
  for (const [staffId, staffEvents] of byStaff) {
    const sorted = [...staffEvents].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    for (let left = 0; left < sorted.length; left += 1) {
      for (let right = left + 1; right < sorted.length; right += 1) {
        if (Date.parse(sorted[right].startAt) >= Date.parse(sorted[left].endAt)) break;
        if (Date.parse(sorted[left].startAt) < Date.parse(sorted[right].endAt)) {
          conflicts.push({
            staffId: Number(staffId),
            ticketIds: [sorted[left].ticketId, sorted[right].ticketId],
            startAt: sorted[right].startAt,
            endAt: Date.parse(sorted[left].endAt) < Date.parse(sorted[right].endAt)
              ? sorted[left].endAt : sorted[right].endAt,
          });
        }
      }
    }
  }
  return conflicts;
}

function buildDayCalendar(db, {
  date, staffId, managerId, communityId, viewerUserId,
}) {
  if (!isValidDate(date)) throw calendarError('date 必须是真实的 YYYY-MM-DD 日期', 'INVALID_DATE');

  const profiles = queryAll(
    db,
    `SELECT id, user_id, name, position, manager_id, employment_status
     FROM staff_profiles WHERE employment_status = 'active' ORDER BY id`
  );
  const viewer = viewerUserId === undefined || viewerUserId === null
    ? null
    : queryAll(db, 'SELECT role FROM users WHERE id = ?', [viewerUserId])[0] || null;
  const allowLegacyNameFallback = Boolean(viewer && isManagerRole(viewer.role));
  let selected = profiles;
  if (staffId !== undefined && staffId !== null && staffId !== '') {
    selected = profiles.filter((profile) => Number(profile.id) === Number(staffId));
  } else if (managerId !== undefined && managerId !== null && managerId !== '') {
    const ids = new Set(descendantIds(profiles, managerId).map(Number));
    selected = profiles.filter((profile) => ids.has(Number(profile.id)));
  } else if (viewerUserId !== undefined && viewerUserId !== null) {
    selected = profiles;
  }

  const selectedIds = selected.map((profile) => Number(profile.id));
  const shifts = selectedIds.length ? queryAll(
    db,
    `SELECT a.*, t.name AS template_name, t.color AS template_color
       FROM shift_assignments a
       LEFT JOIN shift_templates t ON t.id = a.template_id
      WHERE a.work_date = ? AND a.staff_id IN (${selectedIds.map(() => '?').join(', ')})`,
    [date, ...selectedIds]
  ) : [];
  const attendance = selectedIds.length ? queryAll(
    db,
    `SELECT * FROM attendance_records
     WHERE work_date = ? AND staff_id IN (${selectedIds.map(() => '?').join(', ')})`,
    [date, ...selectedIds]
  ) : [];
  const shiftByStaff = new Map(shifts.map((row) => [Number(row.staff_id), row]));
  const attendanceByStaff = new Map(attendance.map((row) => [Number(row.staff_id), row]));
  const profileNameCounts = new Map();
  for (const profile of profiles) {
    profileNameCounts.set(profile.name, (profileNameCounts.get(profile.name) || 0) + 1);
  }
  const uniqueProfileByName = new Map(
    selected.filter((profile) => profile.name && profileNameCounts.get(profile.name) === 1)
      .map((profile) => [profile.name, profile])
  );

  const people = selected.map((profile) => {
    const shift = shiftByStaff.get(Number(profile.id));
    const record = attendanceByStaff.get(Number(profile.id));
    return {
      id: Number(profile.id),
      userId: profile.user_id === null ? null : Number(profile.user_id),
      name: profile.name,
      position: profile.position,
      managerId: profile.manager_id === null ? null : Number(profile.manager_id),
      employmentStatus: profile.employment_status,
      shift: shift ? {
        id: Number(shift.id),
        assignmentType: shift.assignment_type,
        templateId: shift.template_id === null ? null : Number(shift.template_id),
        templateName: shift.template_name || '',
        templateColor: shift.template_color || '',
        startAt: shift.start_at,
        endAt: shift.end_at,
        leaveType: shift.leave_type,
        note: shift.note,
      } : null,
      attendance: record ? {
        id: Number(record.id),
        checkInAt: record.check_in_at,
        checkOutAt: record.check_out_at,
        status: record.status,
        isCorrected: Boolean(record.is_corrected),
      } : null,
    };
  });

  let tickets = [];
  if (selected.length) {
    const identityClauses = [];
    const identityParams = [];
    const userIds = selected.filter((profile) => profile.user_id !== null).map((profile) => profile.user_id);
    const names = allowLegacyNameFallback ? [...uniqueProfileByName.keys()] : [];
    if (userIds.length) {
      identityClauses.push(`assignee_user_id IN (${userIds.map(() => '?').join(', ')})`);
      identityParams.push(...userIds);
    }
    if (names.length) {
      identityClauses.push(`(assignee_user_id IS NULL AND worker IN (${names.map(() => '?').join(', ')}))`);
      identityParams.push(...names);
    }
    if (identityClauses.length) {
      const { from, toExclusive } = shanghaiDayRange(date);
      const where = [
        `(${identityClauses.join(' OR ')})`,
        "julianday(COALESCE(NULLIF(assigned_at, ''), created)) >= julianday(?)",
        "julianday(COALESCE(NULLIF(assigned_at, ''), created)) < julianday(?)",
      ];
      const params = [...identityParams, from, toExclusive];
      if (communityId !== undefined && communityId !== null && communityId !== '') {
        where.push('community_id = ?');
        params.push(communityId);
      }
      tickets = queryAll(
        db,
        `SELECT id, type, cat, desc, loc, status, worker, assignee_user_id,
                assigned_at, created, finished, estimated_hours, community_id
         FROM tickets WHERE ${where.join(' AND ')}
         ORDER BY julianday(COALESCE(NULLIF(assigned_at, ''), created)), id`,
        params
      );
    }
  }

  const profileByUser = new Map(selected.map((profile) => [Number(profile.user_id), profile]));
  const histories = new Map();
  for (const profile of selected) histories.set(Number(profile.id), { avgMinutes: null });
  const userIds = selected
    .filter((profile) => profile.user_id !== null)
    .map((profile) => profile.user_id);
  const uniqueNames = allowLegacyNameFallback ? [...uniqueProfileByName.keys()] : [];
  const aggregateQueries = [];
  const aggregateParams = [];
  const averageExpression = `(julianday(finished)
    - julianday(COALESCE(NULLIF(assigned_at, ''), created))) * 24 * 60`;
  const validDuration = `finished <> ''
    AND julianday(finished) IS NOT NULL
    AND julianday(COALESCE(NULLIF(assigned_at, ''), created)) IS NOT NULL
    AND julianday(finished) > julianday(COALESCE(NULLIF(assigned_at, ''), created))`;
  if (userIds.length) {
    aggregateQueries.push(
      `SELECT 'user' AS key_type, CAST(assignee_user_id AS TEXT) AS key_value,
              AVG(${averageExpression}) AS avg_minutes
       FROM tickets
       WHERE ${validDuration}
         AND assignee_user_id IN (${userIds.map(() => '?').join(', ')})
       GROUP BY assignee_user_id`
    );
    aggregateParams.push(...userIds);
  }
  if (uniqueNames.length) {
    aggregateQueries.push(
      `SELECT 'name' AS key_type, worker AS key_value,
              AVG(${averageExpression}) AS avg_minutes
       FROM tickets
       WHERE ${validDuration}
         AND assignee_user_id IS NULL
         AND worker IN (${uniqueNames.map(() => '?').join(', ')})
       GROUP BY worker`
    );
    aggregateParams.push(...uniqueNames);
  }
  if (aggregateQueries.length) {
    const historyRows = queryAll(
      db,
      aggregateQueries.join('\nUNION ALL\n'),
      aggregateParams
    );
    for (const row of historyRows) {
      const profile = row.key_type === 'user'
        ? profileByUser.get(Number(row.key_value))
        : uniqueProfileByName.get(row.key_value);
      if (profile) {
        histories.set(Number(profile.id), { avgMinutes: Number(row.avg_minutes) });
      }
    }
  }
  const events = tickets.map((ticket) => {
    const profile = ticket.assignee_user_id === null
      ? uniqueProfileByName.get(ticket.worker)
      : profileByUser.get(Number(ticket.assignee_user_id));
    const window = estimateTicketWindow(ticket, histories.get(Number(profile.id)));
    return {
      ticketId: ticket.id,
      staffId: Number(profile.id),
      category: ticket.cat,
      description: ticket.desc,
      location: ticket.loc,
      status: ticket.status,
      communityId: ticket.community_id,
      ...window,
    };
  });

  return {
    date,
    people,
    events,
    conflicts: detectCalendarConflicts(events),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  estimateTicketWindow,
  detectCalendarConflicts,
  buildDayCalendar,
};
